async function setupPlugin({ config, global, storage }) {
    try {
        global.customerIgnoreRegex = new RegExp(config.customerIgnoreRegex)
    } catch {
        throw new Error('Invalid regex for field customerIgnoreRegex.')
    }

    global.invoiceNotificationPeriod = Number(config.invoiceNotificationPeriod)
    if (Number.isNaN(global.invoiceNotificationPeriod)) {
        throw new Error('Invoice notification period specified is not a number.')
    }

    global.invoiceAmountThreshold = Number(config.invoiceAmountThreshold)
    if (Number.isNaN(global.invoiceAmountThreshold)) {
        throw new Error('Threshold specified is not a number.')
    }

    global.defaultHeaders = {
        headers: {
            Authorization: `Bearer ${config.stripeApiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }

    global.onlyRegisterNewCustomers = config.onlyRegisterNewCustomers === 'Yes'
    global.notifyUpcomingInvoices = config.notifyUpcomingInvoices === 'Yes'

    const authResponse = await fetchWithRetry('https://api.stripe.com/v1/customers?limit=1', global.defaultHeaders)

    const jsonRes = await authResponse.json()
    if (!statusOk(authResponse)) {
        throw new Error(
            'Unable to connect to Stripe. Please make sure your API key is correct and that it has the required permissions.'
        )
    }
}

async function runEveryMinute({ global, storage, cache }) {
    const SIX_HOURS = 1000 * 60 * 60 * 6

    // Run every six hours - Using runEveryMinute to run on setup
    const lastRun = await cache.get('lastRun')
    if (lastRun && new Date().getTime() - Number(lastRun) < SIX_HOURS) {
        return
    }

    let cursorParams = ''
    if (global.onlyRegisterNewCustomers) {
        const cursorCache = await storage.get('cursor')
        const cursor = cursorCache || '0'

        // only get customers created after the creation date of the last registered customer
        cursorParams = `&created[gt]=${cursor}`
    }

    let paginationParam = ''

    let customers = []

    let customersJson = { has_more: true }

    let lastCustomerCreatedAt

    while (customersJson.has_more) {
        const customersResponse = await fetchWithRetry(
            `https://api.stripe.com/v1/customers?limit=100${cursorParams}${paginationParam}`,
            global.defaultHeaders
        )
        customersJson = await customersResponse.json()
        const newCustomers = customersJson.data
        
        if (!newCustomers) {
            return
        }

        if (!lastCustomerCreatedAt) {
            lastCustomerCreatedAt = newCustomers[0].created
        }
        const lastObjectId = newCustomers[newCustomers.length - 1].id
        paginationParam = `&starting_after=${lastObjectId}`
        customers = [...customers, ...newCustomers]
    }

    if (global.onlyRegisterNewCustomers && lastCustomerCreatedAt) {
        await storage.set('cursor', lastCustomerCreatedAt)
    }

    for (let customer of customers) {
        // Ignore customers matching the user-specified regex
        if (customer.email && global.customerIgnoreRegex.test(customer.email)) {
            continue
        }

        const hasActiveSubscription = customer.subscriptions && customer.subscriptions.data.length > 0

        // Stripe ensures properties always exist
        const basicProperties = {
            distinct_id: customer.email || customer.id,
            has_active_subscription: hasActiveSubscription,
            customer_name: customer.name,
            currency: customer.currency,
            created: customer.created
        }

        let properties = { ...basicProperties }

        if (hasActiveSubscription) {
            for (let i = 0; i < customer.subscriptions.data.length; ++i) {
                let subscription = customer.subscriptions.data[i]

                properties[`subscription${i}`] = subscription
            }

            properties = flattenProperties({ ...properties })

            if (global.notifyUpcomingInvoices) {
                const lastInvoiceDate = await cache.get(`last_invoice_${customer.id}`)

                // Ensure upcoming_invoice events fire once per billing cycle
                if (!lastInvoiceDate || Number(lastInvoiceDate) < new Date().getTime()) {
                    const upcomingInvoiceResponse = await fetchWithRetry(
                        `https://api.stripe.com/v1/invoices/upcoming?customer=${customer.id}`,
                        global.defaultHeaders
                    )
                    const upcomingInvoice = await upcomingInvoiceResponse.json()

                    const ONE_DAY = 1000 * 60 * 60 * 24

                    const upcomingInvoiceDate = upcomingInvoice.created * 1000

                    if (
                        !upcomingInvoice.error &&
                        upcomingInvoice.created &&
                        upcomingInvoiceDate - new Date().getTime() < ONE_DAY * global.invoiceNotificationPeriod &&
                        upcomingInvoice.amount_due / 100 > global.invoiceAmountThreshold
                    ) {
                        posthog.capture('upcoming_invoice', {
                            stripe_customer_id: customer.id,
                            invoice_date: new Date(upcomingInvoiceDate).toLocaleDateString('en-GB'),
                            invoice_current_amount: upcomingInvoice.amount_due / 100,
                            distinct_id: customer.email || customer.id
                        })
                        await cache.set(`last_invoice_${customer.id}`, upcomingInvoiceDate)
                    }
                }
            }
        }

        const customerRecordExists = await storage.get(customer.id)

        if (!customerRecordExists) {
            await storage.set(customer.id, true)
        }

        posthog.capture(customerRecordExists ? 'update_stripe_customer' : 'new_stripe_customer', {
            ...properties,
            $set: basicProperties
        })
    }

    await cache.set('lastRun', new Date().getTime())
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}

function statusOk(res) {
    return String(res.status)[0] === '2'
}

const flattenProperties = (props, nestedChain = []) => {
    const sep = '__'
    let newProps = {}
    for (const [key, value] of Object.entries(props)) {
        if (Array.isArray(value)) {
            let objectFromArray = {}
            for (let i = 0; i < value.length; ++i) {
                objectFromArray[i] = value[i]
            }
            props[key] = { ...objectFromArray }
            newProps = { ...newProps, ...flattenProperties(props[key], [...nestedChain, key]) }
        } else if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
            newProps = { ...newProps, ...flattenProperties(props[key], [...nestedChain, key]) }
            delete props[key]
        } else {
            if (nestedChain.length > 0 && value !== null) {
                newProps[nestedChain.join(sep) + `${sep}${key}`] = value
            }
        }
    }
    if (nestedChain.length > 0) {
        return { ...newProps }
    }
    return { ...props, ...newProps }
}

module.exports = {
    runEveryMinute,
    setupPlugin
}
