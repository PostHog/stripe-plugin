async function setupPlugin({ config, global, storage }) {
    try {
        global.customerIgnoreRegex = config.customerIgnoreRegex ? new RegExp(config.customerIgnoreRegex) : null
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

    if (!statusOk(authResponse)) {
        throw new Error(
            'Unable to connect to Stripe. Please make sure your API key is correct and that it has the required permissions.'
        )
    }
}

async function fetchAllCustomers(defaultHeaders) {
    let customers = []

    let paginationParam = ''
    let lastCustomerCreatedAt
    let customersJson = { has_more: true }
    while (customersJson.has_more) {
        const customersResponse = await fetchWithRetry(
            `https://api.stripe.com/v1/customers?limit=100${paginationParam}`,
            defaultHeaders
        )
        customersJson = await customersResponse.json()
        const newCustomers = customersJson.data

        if (!newCustomers) {
            break
        }

        if (!lastCustomerCreatedAt) {
            lastCustomerCreatedAt = newCustomers[0].created
        }
        const lastObjectId = newCustomers[newCustomers.length - 1].id
        paginationParam = `&starting_after=${lastObjectId}`
        customers = [...customers, ...newCustomers]
    }

    return customers
}

async function runEveryMinute({ global, storage, cache }) {
    const ONE_HOUR = 1000 * 60 * 60 * 1
    // Run every one hour - Using runEveryMinute to run on setup
    const lastRun = await cache.get('_lastRun')
    if (lastRun && new Date().getTime() - Number(lastRun) < ONE_HOUR) {
        return
    }

    const customers = await fetchAllCustomers(global.defaultHeaders)

    const invoicesByProduct = {}

    for (const customer of customers) {
        // Ignore customers matching the user-specified regex
        if (customer.email && global.customerIgnoreRegex && global.customerIgnoreRegex.test(customer.email)) {
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
        let productName

        if (hasActiveSubscription) {
            for (let i = 0; i < customer.subscriptions.data.length; ++i) {
                let subscription = customer.subscriptions.data[i]
                const productResponse = await fetchWithRetry(
                    `https://api.stripe.com/v1/products/${subscription.plan?.product}`,
                    global.defaultHeaders
                )
                const product = await productResponse.json()
                productName = product?.name
                subscription.product_name = product.name
                properties[`subscription${i}`] = subscription
            }

            properties = flattenProperties({ ...properties })
            if (global.notifyUpcomingInvoices) {
                const upcomingInvoiceResponse = await fetchWithRetry(
                    `https://api.stripe.com/v1/invoices/upcoming?customer=${customer.id}`,
                    global.defaultHeaders
                )
                const upcomingInvoice = await upcomingInvoiceResponse.json()

                const upcomingInvoiceDate = upcomingInvoice.created * 1000

                const invoiceData = {
                    product: productName,
                    amount_due: upcomingInvoice.amount_due / 100,
                    customer: customer.email,
                    quantity: 0
                }
                upcomingInvoice.lines?.data.forEach((line) => {
                    invoiceData.quantity += line.quantity
                })

                if (productName in invoicesByProduct) {
                    invoicesByProduct[productName].push(invoiceData)
                } else {
                    invoicesByProduct[productName] = [invoiceData]
                }

                if (!upcomingInvoice.error && upcomingInvoice.created) {
                    const eventProps = {
                        amount: invoiceData.amount_due,
                        invoice_date: new Date(upcomingInvoiceDate).toLocaleDateString('en-GB'),
                        product: invoiceData.product,
                        quantity: invoiceData.quantity,
                        stripe_customer_id: customer.id,
                        distinct_id: customer.email || customer.id,
                        $set: customer.email ? { email: customer.email } : undefined
                    }
                    posthog.capture('Upcoming Invoice', eventProps)

                    if (global.invoiceAmountThreshold && invoiceData.amount_due > global.invoiceAmountThreshold) {
                        posthog.capture('Upcoming Invoice – Above Threshold', {
                            ...eventProps,
                            ...{ alert_threshold: global.invoiceAmountThreshold }
                        })
                    }
                }
            }
        }

        const customerRecordExists = await storage.get(customer.id)

        if (!customerRecordExists) {
            await storage.set(customer.id, true)
        }

        if (global.onlyRegisterNewCustomers && customerRecordExists) {
            continue
        } else {
            posthog.capture(customerRecordExists ? 'Updated Stripe Customer' : 'Identified Stripe Customer', {
                distinct_id: customer.email || customer.id,
                $set: {
                    ...basicProperties,
                    ...{ subscribed_product: productName }
                }
            })
        }
    }

    logAggregatedInvoices(invoicesByProduct)

    await cache.set('_lastRun', new Date().getTime())
}

function logAggregatedInvoices(invoicesByProduct) {
    const totalsByProduct = {}
    // First we need to sum all the invoices for each product.
    for (const [product, invoices] of Object.entries(invoicesByProduct)) {
        invoices.forEach((invoice) => {
            if (product in totalsByProduct) {
                totalsByProduct[product] += invoice.amount_due
            } else {
                totalsByProduct[product] = invoice.amount_due
            }
        })
    }
    // Now for each product type, we send an event to PostHog with the sum total for that product.
    for (const [product, billingSum] of Object.entries(totalsByProduct)) {
        const props = {
            amount: parseFloat(billingSum.toFixed(2)),
            product: product
        }
        posthog.capture('Upcoming Invoices (Aggregated)', props)
    }
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
