# API Reference

Base URL: http://localhost:3000

## Public
- GET /health
- GET /api/countries

## Auth
- POST /api/auth/register
- GET /api/auth/verify-email?token=
- POST /api/auth/resend-verification
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- POST /api/auth/forgot-password
- POST /api/auth/reset-password
- POST /api/auth/change-password
- GET /api/auth/sessions
- DELETE /api/auth/sessions/:id
- POST /api/auth/mfa/enroll
- POST /api/auth/mfa/confirm
- POST /api/auth/mfa/disable

## Customer
- GET/PATCH /api/customer/profile
- GET/POST /api/customer/vehicles
- PATCH/DELETE /api/customer/vehicles/:id
- POST /api/customer/vehicles/:id/default
- GET/POST /api/customer/destinations
- PATCH/DELETE /api/customer/destinations/:id
- POST /api/customer/bookings/estimate
- POST /api/customer/bookings
- GET /api/customer/bookings
- GET /api/customer/bookings/:id
- GET /api/customer/bookings/:id/tracking
- GET /api/customer/bookings/:id/invoice
- POST /api/customer/bookings/:id/cancel
- POST /api/customer/bookings/:id/dispatch
- POST /api/customer/bookings/:id/dispatch/advance
- GET /api/customer/bookings/:id/payment
- POST /api/customer/bookings/:id/payment/cash-paid
- POST /api/customer/bookings/:id/payment/online/test
- POST /api/customer/bookings/:id/payment/online/test/confirm
- POST /api/customer/bookings/:id/payment/dispute
- GET/POST /api/customer/bookings/:id/chat
- POST/GET /api/customer/tickets
- GET /api/customer/tickets/:id
- POST /api/customer/tickets/:id/messages
- GET /api/customer/notifications
- POST /api/customer/notifications/:id/read
- POST /api/customer/notifications/read-all
## Driver
- GET/PATCH /api/driver/profile
- GET /api/driver/vehicles
- POST /api/driver/current-vehicle
- POST /api/driver/status
- POST /api/driver/location
- GET/POST /api/driver/documents
- DELETE /api/driver/documents/:id
- GET /api/driver/eligibility
- GET /api/driver/bookings/incoming
- POST /api/driver/bookings/:id/accept
- POST /api/driver/bookings/:id/reject
- GET /api/driver/bookings/active
- POST /api/driver/bookings/:id/on-way
- POST /api/driver/bookings/:id/arrived
- POST /api/driver/bookings/:id/loaded
- POST /api/driver/bookings/:id/start-trip
- POST /api/driver/bookings/:id/complete
- POST /api/driver/bookings/:id/cancel
- POST /api/driver/bookings/:id/payment/cash-received
- POST /api/driver/bookings/:id/payment/dispute
- GET/POST /api/driver/bookings/:id/chat
- POST/GET /api/driver/tickets
- GET /api/driver/tickets/:id
- POST /api/driver/tickets/:id/messages
- GET /api/driver/notifications
- POST /api/driver/notifications/:id/read
- POST /api/driver/notifications/read-all

## Agency
- GET/PATCH /api/agency/profile
- GET/POST /api/agency/vehicles
- PATCH/DELETE /api/agency/vehicles/:id
- GET /api/agency/drivers
- POST /api/agency/drivers/:driverId/authorize
- DELETE /api/agency/drivers/:driverId/vehicles/:vehicleId

## Admin (country_admin + super_admin)
- GET /api/admin/whoami
- POST /api/admin/users/:id/force-logout
- GET /api/admin/country
- PATCH /api/admin/country/settings
- PATCH /api/admin/country/services/:code
- GET /api/admin/tickets
- GET /api/admin/tickets/:id
- POST /api/admin/tickets/:id/assign
- POST /api/admin/tickets/:id/status
- POST /api/admin/tickets/:id/resolve
- POST /api/admin/tickets/:id/messages
- POST /api/admin/bookings/:id/payment/resolve-dispute
- GET /api/admin/reports/bookings
- GET /api/admin/reports/bookings.csv
- GET /api/admin/reports/financials
- GET /api/admin/reports/drivers

## Super Admin only
- GET /api/super/countries
- GET /api/super/countries/:code
- POST /api/super/countries
- PATCH /api/super/countries/:code
- GET /api/super/country-admins
- POST /api/super/country-admins
- PATCH /api/super/country-admins/:id
- GET /api/super/analytics
