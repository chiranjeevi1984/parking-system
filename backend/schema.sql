CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'operator'
    CHECK (role IN ('super_admin', 'operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_number VARCHAR(20) UNIQUE NOT NULL,
  phone_number VARCHAR(20) UNIQUE NOT NULL,
  vehicle_type VARCHAR(30) NOT NULL CHECK (vehicle_type IN ('bike','car','van','truck')),
  qr_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parking_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_type VARCHAR(30) NOT NULL UNIQUE CHECK (vehicle_type IN ('bike','car','van','truck')),
  first_hour_rate NUMERIC(10,2) NOT NULL CHECK (first_hour_rate >= 0),
  additional_hour_rate NUMERIC(10,2) NOT NULL CHECK (additional_hour_rate >= 0)
);

CREATE TABLE IF NOT EXISTS parking_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  amount NUMERIC(10,2),
  status VARCHAR(24) NOT NULL DEFAULT 'parked'
    CHECK (status IN ('parked','awaiting_payment','completed')),
  entry_operator_id BIGINT REFERENCES users(id),
  exit_operator_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (exit_time IS NULL OR exit_time >= entry_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_vehicle
ON parking_sessions(vehicle_id)
WHERE status IN ('parked','awaiting_payment');

CREATE TABLE IF NOT EXISTS parking_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT NOT NULL UNIQUE REFERENCES parking_sessions(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash','phonepe','demo')),
  payment_reference VARCHAR(150) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_gateway_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(30) NOT NULL UNIQUE CHECK (provider IN ('phonepe')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  environment VARCHAR(20) NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
  client_id TEXT,
  client_version VARCHAR(40) NOT NULL DEFAULT '1',
  client_secret_encrypted TEXT,
  webhook_key_id VARCHAR(120),
  webhook_secret_encrypted TEXT,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE parking_payments ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100) UNIQUE;
ALTER TABLE parking_payments ADD COLUMN IF NOT EXISTS gateway_response JSONB;
ALTER TABLE parking_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS parking_payments_gateway_order_idx ON parking_payments(gateway_order_id);

INSERT INTO parking_rates (vehicle_type, first_hour_rate, additional_hour_rate)
VALUES ('bike', 10, 5), ('car', 30, 20), ('van', 50, 30), ('truck', 80, 40)
ON CONFLICT (vehicle_type) DO NOTHING;
