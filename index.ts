import { PluginEvent, Plugin, RetryError, CacheExtension, Meta, StorageExtension } from '@posthog/plugin-scaffold'

export async function setupPlugin({ config, global, storage }) {
    if ((config.groupType || config.groupTypeIndex > -1) && !(config.groupType && config.groupTypeIndex > -1)) {
        throw new Error('Both groupType and groupTypeIndex must be set.')
    } else {
        global.groupType = config.groupType
        global.groupTypeIndex = Number(config.groupTypeIndex)
    }
    global.saveUsersIfNotMatched = config.saveUsersIfNotMatched === 'Yes'

    global.defaultHeaders = {
        headers: {
            Authorization: `Bearer ${config.stripeApiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }

    const authResponse = await fetchWithRetry('https://api.stripe.com/v1/customers?limit=1', global.defaultHeaders)

    if (!statusOk(authResponse)) {
        throw new Error(
            'Unable to connect to Stripe. Please make sure your API key is correct and that it has the required permissions.'
        )
    }
}

export const jobs = {
    saveInvoices: async (invoices, { global, storage, cache }) => {
        for (const invoice of invoices) {
            const customer = await getOrSaveCustomer(invoice, invoice.customer, storage, global)

            if (customer || global.saveUsersIfNotMatched) {
                const groupAddition = customer.group_key ? { $groups: { [global.groupType]: customer.group_key } } : {}

                if (invoice.subscription) {
                    await sendSubscriptionEvent(invoice.subscription, customer, storage, groupAddition)
                }
                await sendInvoiceEvent(invoice, customer, global, storage, groupAddition)
            }
        }
    }
}

async function sendGroupEvent(invoice, customer, spent_last_month, spent_total, global) {
    posthog.capture('$groupidentify', {
        distinct_id: customer.distinct_id,
        $group_type: global.groupType,
        $group_key: customer.group_key,
        $group_set: {
            stripe_spent_last_month: spent_last_month,
            stripe_spent_total: spent_total,
            ...(invoice.subscription
                ? {
                      stripe_subscription_status: invoice.subscription.status,
                      stripe_product_name: invoice.subscription?.plan?.product?.name,
                      stripe_subscription_date: new Date(invoice.subscription.created * 1000).toISOString()
                  }
                : {})
        }
    })
}

async function sendInvoiceEvent(invoice, customer, global, storage, groupAddition) {
    const today = new Date()
    const firstDayThisMonth = Math.floor(new Date(today.getFullYear(), today.getMonth(), 1) / 1000)
    const firstDayNextMonth = Math.floor(new Date(today.getFullYear(), today.getMonth() + 1, 1) / 1000)

    const spent_last_month = customer.invoices
        .filter(({ period_end }) => {
            return period_end > firstDayThisMonth && period_end < firstDayNextMonth
        })
        .map(({ amount_paid }) => amount_paid)
        .reduce((prev, cur) => prev + cur, 0)

    const spent_total = customer.invoices.reduce((prev, cur) => prev.amount_paid + cur.amount_paid, { amount_paid: 0 })
    posthog.capture('Stripe Invoice Paid', {
        distinct_id: customer.distinct_id,
        timestamp: toISOString(invoice.period_end),
        stripe_customer_id: invoice.customer.id,
        stripe_amount_paid: invoice.amount_paid / 100,
        ...groupAddition,
        $set: {
            stripe_spent_last_month: spent_last_month,
            stripe_spent_total: spent_total,
            stripe_subscription_status: invoice.subscription?.status
        }
    })
    await storage.set(`invoice_${invoice.id}`, 1)

    if (global.groupType) {
        sendGroupEvent(invoice, customer, spent_last_month, spent_total, global)
    }
}

async function sendSubscriptionEvent(subscription, customer, storage, groupAddition) {
    const fromStorage = await storage.get(`subscription_${subscription.id}`)
    if (fromStorage) {
        return
    }
    posthog.capture('Stripe Customer Subscribed', {
        distinct_id: customer.distinct_id,
        timestamp: toISOString(subscription.created),
        stripe_customer_id: subscription.customer,
        stripe_product_name: subscription.plan?.product?.name,
        ...groupAddition,
        $set: {
            stripe_subscription_date: new Date(subscription.created * 1000).toISOString(),
            stripe_product_name: subscription.plan?.product?.name
        }
    })

    await storage.set(`subscription_${customer.id}`, true)
}

async function getGroupTypeKey(person_id, global) {
    const req = await posthog.api.get(`/api/projects/@current/groups/related?id=${person_id}`)
    const groups = await req.json()
    return groups.filter((group) => group.group_type_index == global.groupTypeIndex)[0].group_key
}

async function getOrSaveCustomer(invoice, customer, storage, global) {
    let fromStorage = await storage.get(`customer_${customer.id}`)
    if (!fromStorage) {
        fromStorage = { invoices: [] }
        if (customer.metadata?.posthog_distinct_id) {
            fromStorage['distinct_id'] = customer.metadata.posthog_distinct_id
        } else {
            const req = await posthog.api.get(`/api/projects/@current/persons/?email=${customer.email}`)
            const posthogPerson = await req.json()
            if (!posthogPerson.results) {
                console.warn("Can't reach PostHog to find persons", posthogPerson)
                if (!global.saveUsersIfNotMatched) {
                    return
                }
            } else if (posthogPerson.results.length === 0) {
                console.warn(`Can't find ${customer.email} in PostHog`)
                if (!global.saveUsersIfNotMatched) {
                    return
                }
                fromStorage['distinct_id'] = customer.email
            } else {
                if (posthogPerson.results.length > 1) {
                    console.warn(`Found multiple results for ${customer.email} in PostHog. Using first one.`)
                }
                fromStorage['distinct_id'] = posthogPerson.results[0]['distinct_ids'][0]
                fromStorage['person_id'] = posthogPerson.results[0]['id']
                console.log(global.groupType)
            }
        }
        if (global.groupType) {
            fromStorage['group_key'] = await getGroupTypeKey(fromStorage.person_id, global)
        }

        posthog.capture('Stripe Customer Created', {
            distinct_id: fromStorage.distinct_id,
            timestamp: toISOString(customer.created),
            stripe_customer_id: customer.id,
            ...(fromStorage.group_key ? { $groups: { [global.groupType]: fromStorage.group_key } } : {})
        })
    }
    fromStorage.invoices.push({
        invoice_id: invoice.id,
        amount_paid: invoice.amount_paid / 100,
        period_end: invoice.period_end
    })

    await storage.set(`customer_${customer.id}`, fromStorage)
    return fromStorage
}

async function asyncFilter(arr, callback) {
    const fail = Symbol()
    return (await Promise.all(arr.map(async (item) => ((await callback(item)) ? item : fail)))).filter(
        (i) => i !== fail
    )
}

export async function runEveryMinute({ storage, jobs, global }: Meta) {
    const TEN_MINUTES = 1000 * 60 * 10
    const paginationParam = await storage.get('paginationParam', '')
    const invoiceResponse = await fetchWithRetry(
        `https://api.stripe.com/v1/invoices?limit=100&status=paid&expand[]=data.customer&expand[]=data.subscription.plan.product${paginationParam}`,
        global.defaultHeaders
    )
    const invoiceJson = await invoiceResponse.json()
    const newPayments = invoiceJson.data

    if (!newPayments) {
        console.log(`No results.`)
        return
    }

    let newInvoices = await asyncFilter(newPayments, async function (invoice) {
        return !(await storage.get(`invoice_${invoice.id}`, false))
    })

    if (newInvoices.length > 0) {
        console.log(`Trying to save ${newInvoices.length} new invoices, pagination "${paginationParam}"`)
        await jobs.saveInvoices(newInvoices).runNow()
    } else {
        console.log(`Page has no unseen invoices, pagination ${paginationParam}`)
    }
    if (invoiceJson.has_more) {
        const lastObjectId = newPayments[newPayments.length - 1].id
        await storage.set('paginationParam', `&starting_after=${lastObjectId}`)
    } else {
        console.log(`Paginated all pages, starting from scratch.`)
    }

    return
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

function toISOString(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString()
}
