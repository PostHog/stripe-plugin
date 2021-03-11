const { getMeta, resetMeta, createEvent } = require('@posthog/plugin-scaffold/test/utils.js')
const { setupPlugin, runEveryMinute } = require('../index')
const { newCustomerEventProps } = require('./constants')
const upcomingInvoiceRes = require('./upcoming-invoice.json')
const customersRes = require('./customers.json')

global.fetch = jest.fn(async (url) => ({
    json: async () => (url.includes('/customers') ? customersRes : upcomingInvoiceRes),
    status: 200
}))

global.posthog = {
    capture: jest.fn(() => true)
}

storage = {
    get: jest.fn(() => ''),
    set: jest.fn(() => '')
}

cache = {
    get: jest.fn(() => ''),
    set: jest.fn(() => '')
}

beforeEach(() => {
    fetch.mockClear()
    posthog.capture.mockClear()

    resetMeta({
        config: {
            stripeApiKey: 'STRIPE_KEY',
            onlyRegisterNewCustomers: 'Yes',
            notifyUpcomingInvoices: 'Yes',
            invoiceNotificationPeriod: '20000',
            invoiceAmountThreshold: '100'
        },
        global: global,
        storage: storage,
        cache: cache
    })
})

test('setupPlugin tests stripe key', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)

    await setupPlugin(getMeta())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://api.stripe.com/v1/customers?limit=1', {
        method: 'GET',
        headers: {
            Authorization: 'Bearer STRIPE_KEY',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
})

test('runEveryMinute', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)

    await runEveryMinute(getMeta())
    expect(posthog.capture).toHaveBeenCalledTimes(2)
    expect(posthog.capture).toHaveBeenNthCalledWith(1, 'upcoming_invoice', {
        distinct_id: 'cus_J632IbQFZfXXt5',
        invoice_current_amount: 150,
        invoice_date: '02/03/2021',
        stripe_customer_id: 'cus_J632IbQFZfXXt5'
    })
    expect(posthog.capture).toHaveBeenNthCalledWith(2, 'new_stripe_customer', newCustomerEventProps)
})
