-- Sample schema for local development.
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  full_name   text NOT NULL,
  country     char(2),
  profile     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_has_at CHECK (position('@' in email) > 1)
);

CREATE TABLE inventory.products (
  id          serial PRIMARY KEY,
  sku         varchar(32) NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  tags        text[],
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id   integer NOT NULL REFERENCES inventory.products(id),
  quantity     integer NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'pending',
  placed_at    timestamptz NOT NULL DEFAULT now(),
  note         text
);
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_status_placed_idx ON orders(status, placed_at DESC);

INSERT INTO customers (email, full_name, country, profile, created_at)
SELECT 'user' || g || '@example.com',
       (ARRAY['Ada','Grace','Linus','Ken','Barbara','Edsger','Margaret','Dennis'])[1 + g % 8] || ' ' ||
       (ARRAY['Lovelace','Hopper','Torvalds','Thompson','Liskov','Dijkstra','Hamilton','Ritchie'])[1 + (g * 7) % 8],
       (ARRAY['US','DE','IQ','JP','BR','FR', NULL])[1 + g % 7],
       CASE WHEN g % 3 = 0 THEN NULL ELSE jsonb_build_object('tier', (ARRAY['free','pro','team'])[1 + g % 3], 'newsletter', g % 2 = 0, 'score', g * 13 % 100) END,
       now() - (g || ' hours')::interval
FROM generate_series(1, 2500) g;

INSERT INTO inventory.products (sku, name, price_cents, tags, active)
SELECT 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g, (g * 137) % 50000 + 99,
       ARRAY['tag' || (g % 5), 'cat' || (g % 3)], g % 11 <> 0
FROM generate_series(1, 400) g;

INSERT INTO orders (customer_id, product_id, quantity, status, placed_at, note)
SELECT 1 + (g * 31) % 2500, 1 + (g * 17) % 400, 1 + g % 5,
       (ARRAY['pending','paid','shipped','delivered','refunded'])[1 + g % 5],
       now() - (g || ' minutes')::interval,
       CASE WHEN g % 9 = 0 THEN 'gift wrap' END
FROM generate_series(1, 20000) g;

CREATE VIEW customer_order_totals AS
SELECT c.id, c.email, count(o.id) AS orders, coalesce(sum(o.quantity * p.price_cents), 0) AS total_cents
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id LEFT JOIN inventory.products p ON p.id = o.product_id
GROUP BY c.id, c.email;

CREATE FUNCTION order_count(cid integer) RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT count(*) FROM orders WHERE customer_id = cid $$;
