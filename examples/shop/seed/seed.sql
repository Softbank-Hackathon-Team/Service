-- DRAFT(ai): 결정적 시드. scale=1 이면 고객 20,000 / 상품 1,000 / 주문 60,000 / 주문 항목 약 180,000.
-- 같은 scale 이면 언제나 같은 행 → 이관 전후 행 수·합계 비교에 쓴다.
SET search_path = shop;
SELECT setseed(0.42);

INSERT INTO customers (email, name, region, created_at)
SELECT 'user' || g || '@example.com',
       'customer-' || g,
       (ARRAY['seoul','busan','tokyo','osaka','incheon'])[1 + (g % 5)],
       timestamptz '2026-01-01' + (g || ' minutes')::interval
FROM generate_series(1, 20000 * :scale) g;

INSERT INTO products (sku, name, price_krw, stock)
SELECT 'SKU-' || lpad(g::text, 6, '0'),
       'product-' || g,
       1000 + (g * 37 % 99) * 500,
       1000
FROM generate_series(1, 1000) g;

INSERT INTO orders (client_ref, customer_id, status, total_krw, created_at, updated_at)
SELECT md5('seed-order-' || g)::uuid,
       1 + (g * 7919 % (20000 * :scale)),
       (ARRAY['placed','paid','shipped','cancelled'])[1 + (g % 4)],
       0,
       timestamptz '2026-03-01' + (g || ' seconds')::interval,
       timestamptz '2026-03-01' + (g || ' seconds')::interval
FROM generate_series(1, 60000 * :scale) g;

INSERT INTO order_items (order_id, product_id, qty, price_krw)
SELECT o.id,
       1 + ((o.id * 31 + k * 101) % 1000),
       1 + ((o.id + k) % 3),
       p.price_krw
FROM orders o
CROSS JOIN generate_series(1, 3) k
JOIN products p ON p.id = 1 + ((o.id * 31 + k * 101) % 1000);

UPDATE orders o SET total_krw = s.total
FROM (SELECT order_id, sum(qty * price_krw)::int AS total FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

ANALYZE;

SELECT 'customers' AS t, count(*) FROM customers
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items;
