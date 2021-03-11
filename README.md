# Stripe Plugin

Get customer and invoice data from Stripe into PostHog.

This plugin will:

* Associate your Stripe customers with PostHog users
* Create a PostHog user from a Stripe customer if it doesn't exist
* Emit events for every new customer
* Set the Stripe customer data as user properties in PostHog
* Notify you of upcoming invoices above a certain threshold