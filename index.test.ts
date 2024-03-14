import { getMeta, resetMeta } from '@posthog/plugin-scaffold/test/utils.js'
import { setupPlugin, jobs, runEveryMinute, INVOICE_EVENT_TIMESTAMP_TYPES } from './index'
import 'jest'

global.fetch = jest.fn(async (url) => ({
    json: async () => {
        if (url.includes('/invoices')) {
            if (url.includes('starting_after')) {
                return require('./__tests__/invoice_page2.json')
            } else {
                return require('./__tests__/invoice_page1.json')
            }
        }
    },
    status: 200
}))

global.posthog = {
    capture: jest.fn(() => true),
    api: {
        get: jest.fn((url) => ({
            json: async () => {
                if (url.includes('/related')) {
                    return require('./__tests__/related_groups.json')
                }
                return { results: [{ id: 'posthog-uuid', distinct_ids: ['test_distinct_id'] }] }
            }
        }))
    }
}

const cache = {
    get: jest.fn(() => ''),
    set: jest.fn(() => '')
}

let storage: any
let mockStorage: any
let meta: any
beforeEach(() => {
    fetch.mockClear()
    posthog.capture.mockClear()
    posthog.api.get.mockClear()
    global.groupType = undefined
    global.groupTypeIndex = undefined
    global.getInvoiceTimestamp = INVOICE_EVENT_TIMESTAMP_TYPES['Invoice Period End Date']

    mockStorage = new Map()
    storage = {
        // Based of https://github.com/PostHog/posthog/blob/master/plugin-server/src/worker/vm/extensions/storage.ts
        get: async function (key, defaultValue) {
            await Promise.resolve()
            if (mockStorage.has(key)) {
                const res = mockStorage.get(key)
                if (res) {
                    return JSON.parse(String(res))
                }
            }
            return defaultValue
        },
        set: async function (key, value) {
            await Promise.resolve()
            if (typeof value === 'undefined') {
                mockStorage.delete(key)
            } else {
                mockStorage.set(key, JSON.stringify(value))
            }
        },
        del: async function (key) {
            await Promise.resolve()
            mockStorage.delete(key)
        }
    }

    meta = {
        config: {
            stripeApiKey: 'STRIPE_KEY',
            onlyRegisterNewCustomers: 'Yes',
            notifyUpcomingInvoices: 'Yes',
            invoiceNotificationPeriod: '20000',
            invoiceAmountThreshold: '100',
            capturePaidInvoices: 'Yes'
        },
        global: global,
        storage: storage,
        cache: cache,
        jobs: {
            saveInvoices: (payload) => ({
                runNow: async () => {
                    await jobs.saveInvoices(payload, meta)
                    return jest.fn()
                }
            })
        }
    }
})
jest.useFakeTimers().setSystemTime(new Date('2022-07-08'))

test('setupPlugin tests stripe key', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)

    await setupPlugin(meta)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://api.stripe.com/v1/customers?limit=1', {
        method: 'GET',
        headers: {
            Authorization: 'Bearer STRIPE_KEY',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
})

test('setupPlugin groupType and groupTypeIndex need to be set', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)
    global.groupType = 'test'

    await expect(setupPlugin({ ...meta, config: { groupType: 'test' } })).rejects.toThrow(Error)

    await expect(setupPlugin({ ...meta, config: { groupTypeIndex: 0 } })).rejects.toThrow(Error)

    await setupPlugin({ ...meta, config: { groupTypeIndex: 0, groupType: 'test' } })
})

test('runEveryMinute', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)
    expect(posthog.capture).toHaveBeenCalledTimes(0)

    await runEveryMinute(meta)

    // 2 pagination responses
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(posthog.api.get).toHaveBeenCalledTimes(1)
    expect(posthog.capture).toHaveBeenCalledTimes(3)

    await runEveryMinute(meta)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(posthog.api.get).toHaveBeenCalledTimes(2)
    expect(posthog.capture).toHaveBeenCalledTimes(6)

    expect(posthog.capture).toHaveBeenNthCalledWith(1, 'Stripe Customer Created', {
        distinct_id: 'test_distinct_id',
        timestamp: '2021-09-27T15:59:53.000Z',
        stripe_customer_id: 'cus_stripeid1'
    })

    expect(posthog.capture).toHaveBeenNthCalledWith(2, 'Stripe Customer Subscribed', {
        distinct_id: 'test_distinct_id',
        timestamp: '2021-09-27T16:00:09.000Z',
        stripe_product_name: 'posthog/license automated tests',
        stripe_customer_id: 'cus_stripeid1',
        $set: {
            stripe_subscription_date: '2021-09-27T16:00:09.000Z',
            stripe_product_name: 'posthog/license automated tests',
            stripe_customer_id: 'cus_stripeid1'
        }
    })

    expect(posthog.capture).toHaveBeenNthCalledWith(3, 'Stripe Invoice Paid', {
        distinct_id: 'test_distinct_id',
        timestamp: '2022-07-27T16:00:09.000Z',
        stripe_customer_id: 'cus_stripeid1',
        stripe_amount_paid: 2000,
        stripe_amount_due: 2000,
        stripe_invoice_id: 'in_1LQCjqEuIatRXSdzeGJDxXm1',
        $set: {
            stripe_subscription_status: 'active',
            stripe_due_last_month: 2000,
            stripe_due_total: 2000,
            stripe_paid_last_month: 2000,
            stripe_paid_total: 2000,
            stripe_customer_id: 'cus_stripeid1'
        }
    })

    // second pagination, we should be the stripe page, but nothing else should happen
    await runEveryMinute(meta)
    expect(posthog.api.get).toHaveBeenCalledTimes(2)
    expect(posthog.capture).toHaveBeenCalledTimes(6)
    expect(fetch).toHaveBeenCalledTimes(3)

    // Pretend we've gone all the way round
    await storage.set('paginationParam', false)
    await runEveryMinute(meta)

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch).toHaveBeenNthCalledWith(
        4,
        'https://api.stripe.com/v1/invoices?limit=100&status=paid&expand[]=data.customer&expand[]=data.subscription.plan.product',
        {
            headers: { Authorization: 'Bearer undefined', 'Content-Type': 'application/x-www-form-urlencoded' },
            method: 'GET'
        }
    )
})

test('run with grouptypeindex set', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)
    expect(posthog.capture).toHaveBeenCalledTimes(0)
    global.groupType = 'organizations'
    global.groupTypeIndex = 0

    await runEveryMinute(meta)
    await runEveryMinute(meta)

    console.log('hiii', await storage.get('customer_cus_stripeid1'))
    expect(posthog.capture).toHaveBeenNthCalledWith(1, 'Stripe Customer Created', {
        distinct_id: 'test_distinct_id',
        timestamp: '2021-09-27T15:59:53.000Z',
        stripe_customer_id: 'cus_stripeid1',
        $groups: { organizations: '01823f10-a0c9-0000-73c5-19499a02cb1c' }
    })

    expect(posthog.capture).toHaveBeenNthCalledWith(2, 'Stripe Customer Subscribed', {
        distinct_id: 'test_distinct_id',
        timestamp: '2021-09-27T16:00:09.000Z',
        stripe_product_name: 'posthog/license automated tests',
        stripe_customer_id: 'cus_stripeid1',
        $set: {
            stripe_subscription_date: '2021-09-27T16:00:09.000Z',
            stripe_product_name: 'posthog/license automated tests',
            stripe_customer_id: 'cus_stripeid1'
        },
        $groups: { organizations: '01823f10-a0c9-0000-73c5-19499a02cb1c' }
    })

    expect(posthog.capture).toHaveBeenNthCalledWith(4, '$groupidentify', {
        distinct_id: 'test_distinct_id',
        $group_type: 'organizations',
        $group_key: '01823f10-a0c9-0000-73c5-19499a02cb1c',
        $group_set: {
            stripe_subscription_status: 'active',
            stripe_due_last_month: 2000,
            stripe_due_total: 2000,
            stripe_paid_last_month: 2000,
            stripe_paid_total: 2000,
            stripe_subscription_date: '2021-09-27T16:00:09.000Z',
            stripe_product_name: 'posthog/license automated tests'
        }
    })

    expect(posthog.api.get).toHaveBeenCalledTimes(4)
})

test("Don't save users if not matched option", async () => {
    global.saveUsersIfNotMatched = false

    global.posthog['api'] = {
        get: jest.fn((url) => ({
            json: async () => {
                return { results: [] }
            }
        }))
    }
    expect(fetch).toHaveBeenCalledTimes(0)
    expect(posthog.capture).toHaveBeenCalledTimes(0)

    await runEveryMinute(meta)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(posthog.api.get).toHaveBeenCalledTimes(1)
    expect(posthog.capture).toHaveBeenCalledTimes(0)
})

test('save users if not matched option', async () => {
    global.saveUsersIfNotMatched = true

    global.posthog['api'] = {
        get: jest.fn((url) => ({
            json: async () => {
                return { results: [] }
            }
        }))
    }
    expect(fetch).toHaveBeenCalledTimes(0)
    expect(posthog.capture).toHaveBeenCalledTimes(0)

    await runEveryMinute(meta)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(posthog.api.get).toHaveBeenCalledTimes(1)
    expect(posthog.capture).toHaveBeenCalledTimes(3)
})

test('Use distinct_id from meta', async () => {
    global.saveUsersIfNotMatched = false

    global.posthog['api'] = {
        get: jest.fn((url) => ({
            json: async () => {
                return { results: [] }
            }
        }))
    }

    global.fetch = jest.fn(async (url) => ({
        json: async () => {
            if (url.includes('/invoices')) {
                if (url.includes('starting_after')) {
                    return require('./__tests__/invoice_page2.json')
                } else {
                    let dd = require('./__tests__/invoice_page1.json')
                    dd['data'][0]['customer']['metadata'] = {
                        posthog_distinct_id: 'test_metadata'
                    }
                    return dd
                }
            }
        },
        status: 200
    }))

    expect(fetch).toHaveBeenCalledTimes(0)
    expect(posthog.capture).toHaveBeenCalledTimes(0)

    await runEveryMinute(meta)

    expect(posthog.capture).toHaveBeenNthCalledWith(1, 'Stripe Customer Created', {
        distinct_id: 'test_metadata',
        timestamp: '2021-09-27T15:59:53.000Z',
        stripe_customer_id: 'cus_stripeid1'
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(posthog.api.get).toHaveBeenCalledTimes(1)
    expect(posthog.capture).toHaveBeenCalledTimes(3)
})
