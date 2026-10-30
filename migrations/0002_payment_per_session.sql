-- One payment row per checkout session: a second finalize (return URL racing the webhook) cannot record a second payment.
CREATE UNIQUE INDEX IF NOT EXISTS payments_session_unique ON payments(session_id);
