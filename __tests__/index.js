const { getMeta, resetMeta, createEvent } = require('@posthog/plugin-scaffold/test/utils.js')
const { setupPlugin, runEveryDay, processEventBatch } = require('../index')
const defaultRes = require('./res.json')


global.fetch = jest.fn(async () => ({
    json: async () => defaultRes,
    status: 200
}))


beforeEach(() => {
    fetch.mockClear()
})


