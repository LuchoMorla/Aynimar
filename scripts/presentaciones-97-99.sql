-- Presentaciones con precio propio para 97 (lanzador) y 99 (cepillo).
-- NO EJECUTAR hasta que feat/variant-pricing esté desplegado en backend, tienda y panel,
-- y con aprobación de Luis (cambia lo que se vende en producción).
--
-- Qué hace (una sola transacción; aborta si los datos no son los esperados):
--   1. Copia 97-100 a backup_presentaciones_20261023 (solo si no existe: nunca pisa la copia).
--   2. 97: «1 unidad» $27,99 y «Pack x2» $37,99, ambos Dropi 156158 (qty 1 / 2).
--   3. 99: «1 unidad» $26,99 y «Pack x2» $37,99, ambos Dropi 78443 (qty 1 / 2).
--   4. 98 y 100: show_shop = false (NO se borran: los carritos y pedidos que los usan siguen).
--
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/presentaciones-97-99.sql
-- Reversión: scripts/presentaciones-97-99.revert.sql

BEGIN;

-- Antes: carritos abiertos con 97/99 sin presentación elegida. Tras el cambio, al
-- confirmarse se cobran a precio de «1 unidad» pero el despacho automático los bloquea
-- (variant_mismatch → cola manual). Revisa esta lista antes y después.
SELECT op.order_id, op.product_id, op.amount
FROM orders_products op JOIN orders o ON o.id = op.order_id
WHERE op.product_id IN (97, 99) AND o.state = 'carrito'
  AND (op.selected_dropi_id IS NULL OR op.selected_dropi_id = '');

DO $$
BEGIN
  IF (SELECT count(*) FROM products WHERE id IN (97, 98, 99, 100) AND is_deleted = false) <> 4 THEN
    RAISE EXCEPTION 'Abortado: 97-100 no existen todos o alguno está borrado';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE id IN (97, 99) AND is_bundle IS TRUE) THEN
    RAISE EXCEPTION 'Abortado: 97 o 99 ya es pack (is_bundle)';
  END IF;
  IF (SELECT price FROM products WHERE id = 97) <> 27.99 OR (SELECT price FROM products WHERE id = 99) <> 26.99
     OR (SELECT price FROM products WHERE id = 98) <> 37.99 OR (SELECT price FROM products WHERE id = 100) <> 37.99 THEN
    RAISE EXCEPTION 'Abortado: los precios no son los del catálogo R1 (27,99 / 37,99 / 26,99 / 37,99)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS backup_presentaciones_20261023 AS
  SELECT id, price, dropi_product_id, dropi_items, is_bundle, show_shop, now() AS saved_at
  FROM products WHERE id IN (97, 98, 99, 100);

UPDATE products SET
  dropi_product_id = '156158',
  is_bundle = false,
  dropi_items = '[{"id":"97-1","dropiId":"156158","value":"1 unidad","qty":1,"price":27.99},
                  {"id":"97-x2","dropiId":"156158","value":"Pack x2","qty":2,"price":37.99}]'::jsonb
WHERE id = 97;

UPDATE products SET
  dropi_product_id = '78443',
  is_bundle = false,
  dropi_items = '[{"id":"99-1","dropiId":"78443","value":"1 unidad","qty":1,"price":26.99},
                  {"id":"99-x2","dropiId":"78443","value":"Pack x2","qty":2,"price":37.99}]'::jsonb
WHERE id = 99;

UPDATE products SET show_shop = false WHERE id IN (98, 100);

SELECT id, price, show_shop, is_bundle, dropi_product_id, dropi_items FROM products WHERE id IN (97, 98, 99, 100) ORDER BY id;

COMMIT;
