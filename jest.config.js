/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',

    // The below two options improve jest speed when using ts-jest. It might just
    // be worth using babel tbh.
    // See https://stackoverflow.com/a/60905543 for more details
    maxWorkers: '1',
    globals: {
        'ts-jest': {
            isolatedModules: true
        }
    }
}
