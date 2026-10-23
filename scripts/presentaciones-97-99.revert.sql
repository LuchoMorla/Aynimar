-- Revierte presentaciones-97-99.sql desde la copia que hizo ese script.
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/presentaciones-97-99.revert.sql
-- La tabla de copia se conserva (bórrala a mano cuando ya no haga falta).
BEGIN;
DO $$
BEGIN
  IF (SELECT count(*) FROM backup_presentaciones_20261023 WHERE id IN (97, 98, 99, 100)) <> 4 THEN
    RAISE EXCEPTION 'Abortado: la copia no tiene las 4 filas';
  END IF;
END $$;
UPDATE products p SET
  price = b.price, dropi_product_id = b.dropi_product_id, dropi_items = b.dropi_items,
  is_bundle = b.is_bundle, show_shop = b.show_shop
FROM backup_presentaciones_20261023 b WHERE p.id = b.id;
SELECT id, price, show_shop, is_bundle, dropi_product_id, dropi_items FROM products WHERE id IN (97, 98, 99, 100) ORDER BY id;
COMMIT;
