# Private digest email relay

The worker sends weekly chat summaries through a small Google Apps Script owned by
the same Google account that sends the email. This removes the Resend dependency and
keeps the recipient fixed at the relay.

1. Open [Google Apps Script](https://script.google.com/) and create a new project.
2. Replace the editor contents with `tools/google-apps-script-digest.gs`.
3. In **Project Settings → Script Properties**, add:
   - `DIGEST_TOKEN`: a long random value (at least 32 random bytes).
   - `DIGEST_TO_EMAIL`: the destination email address.
4. Choose **Deploy → New deployment → Web app**. Run it as yourself and allow anyone
   to invoke it; the shared token is what authorizes the worker. Copy the `/exec` URL.
5. Add these secrets/settings to the Sites worker:
   - `DIGEST_WEBHOOK_URL`: the `/exec` URL.
   - `DIGEST_WEBHOOK_SECRET`: exactly the same value as `DIGEST_TOKEN`.
   - `DIGEST_TO_EMAIL`: exactly the same address as the Script Property.
   - `DIGEST_INTERVAL_DAYS`: optional; defaults to `7`.
6. Open `/admin` and use **Send one now** to verify delivery. On Sites, the first chat
   request after the interval is due sends the next digest; opening the dashboard also
   performs the due-date check.

Never commit the token, relay URL, or plain destination address to the repository.
