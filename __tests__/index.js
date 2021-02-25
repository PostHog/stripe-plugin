const { getMeta, resetMeta, createEvent } = require('@posthog/plugin-scaffold/test/utils.js')
const { setupPlugin, runEveryDay, processEventBatch } = require('../index')
const defaultRes = require('./res.json')


global.fetch = jest.fn(async () => ({
    json: async () => defaultRes,
    status: 200
}))


beforeEach(() => {
    fetch.mockClear()

    resetMeta({
        config: {
            mailboxlayerApiKey: 'MAILBOX_KEY'
        },
        global: global
    })
})

test('setupPlugin', async () => {
    expect(fetch).toHaveBeenCalledTimes(0)

    await setupPlugin(getMeta())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
        'https://apilayer.net/api/check?access_key=MAILBOX_KEY&email=test@example.com&format=1',
        {"method": "GET"}
    )
})

test('adds email score to event', async () => {
    const processedEvents = await processEventBatch([createEvent({event: '$identify', distinct_id: 'hey@posthog.com'})],getMeta())
    expect(fetch).toHaveBeenCalledTimes(1)

    expect(processedEvents[0]['$set']).toEqual({"email_score": 0.96, "suggested_email_fix": ""})
})

