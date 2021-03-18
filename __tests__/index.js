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
            invoiceAmountThreshold: '100',
            capturePaidInvoices: 'Yes'
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

    const testNumberOfCaptureCalls = () => {
        expect(posthog.capture).toHaveBeenCalledTimes(5)
    }
    testNumberOfCaptureCalls()

    const testUpcomingInvoice = () => {
        expect(posthog.capture).toHaveBeenCalledWith('Upcoming Invoice', {
            distinct_id: 'cus_J632IbQFZfXXt5',
            amount: 150,
            invoice_date: '02/03/2021',
            stripe_customer_id: 'cus_J632IbQFZfXXt5',
            quantity: 0,
            $set: undefined
        })
    }
    testUpcomingInvoice()

    const testPaidInvoices = () => {
        const today = new Date()
        const firstDayThisMonth = new Date(today.getFullYear(), today.getMonth(), 1)
        const invoicePeriod = firstDayThisMonth.toLocaleDateString('en-GB')
        expect(posthog.capture).toHaveBeenCalledWith('Paid Invoices', { amount: 0, period: invoicePeriod })
    }
    testPaidInvoices()

    const testInvoiceAlerts = () => {
        expect(posthog.capture).toHaveBeenCalledWith('Upcoming Invoice – Above Threshold', {
            distinct_id: 'cus_J632IbQFZfXXt5',
            amount: 150,
            invoice_date: '02/03/2021',
            stripe_customer_id: 'cus_J632IbQFZfXXt5',
            alert_threshold: 100,
            product: undefined,
            quantity: 0,
            $set: undefined
        })
    }
    testInvoiceAlerts()
})
