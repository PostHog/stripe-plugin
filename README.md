# Stripe Plugin

> [!WARNING]  
> This plugin has been deprecated. You can use the [Data Warehouse integeration](https://posthog.com/docs/data-warehouse/setup/stripe) to sync all data reliably from Stripe into PostHog.


Get customer and invoice data from Stripe into PostHog.

This plugin will:

* Associate your Stripe customers with PostHog users
* Create a PostHog user from a Stripe customer if it doesn't exist
* Emit events for every new customer
* Set the Stripe customer data as user properties in PostHog
* Notify you of upcoming invoices above a certain threshold
