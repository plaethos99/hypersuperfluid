---
name: data-engineering
description: SQL, data pipelines, ETL and ELT, dbt, Spark, Airflow and other orchestrators, warehouses and lakes, data modelling and data quality. Load before querying, moving or transforming data.
---

# Data engineering

## Before touching data

1. Know the engine and version (PostgreSQL, MySQL, SQL Server, Snowflake, BigQuery, Databricks, DuckDB): dialects and costs differ.
2. Read the schema and a sample: columns, types, keys, row counts, null rates, and the grain (what one row means). Most wrong answers come from a misunderstood grain.
3. Bound exploration: `LIMIT`, a date filter, `TABLESAMPLE`, or a count first. On billed warehouses, check the bytes a query will scan before running it (BigQuery dry run, Snowflake warehouse size).
4. Reads are free. Writes, deletes, `TRUNCATE`, `DROP`, `ALTER`, backfills and permission changes on shared data wait for a yes, with the exact statement shown and the row count it will touch.

## SQL that stays correct

- Join on keys whose uniqueness you checked; count rows before and after each join to catch fan-out.
- `COUNT(DISTINCT ...)` and window functions over aggregate-then-join when grains differ.
- Remember `NULL`: `NOT IN` with a null returns nothing, `= NULL` is never true, `COALESCE` deliberately.
- Time: store UTC, convert at the edge, and be explicit about inclusive and exclusive date bounds.
- Money: decimal types, never float.
- Use CTEs to name each step; parameters, never string-built SQL.

## Pipelines

- **Idempotent and re-runnable:** a rerun of the same interval gives the same result (merge or upsert on a key, or delete-and-insert the partition inside one transaction).
- **Incremental by a reliable watermark** (updated_at plus a lookback window, or change data capture), with a full-refresh path.
- **Late and duplicate data:** deduplicate on a business key with a deterministic tie-break.
- **Schema changes:** detect them and fail loudly, or evolve explicitly; never drop columns silently.
- **Secrets** from the platform's secret store or environment variables, never in code or DAG files.

## Tools

- **dbt:** sources with freshness, staging then intermediate then marts; `unique`, `not_null`, `relationships` and `accepted_values` tests on keys; `dbt build --select state:modified+` in CI; incremental models with `unique_key`.
- **Airflow, Dagster, Prefect:** one task per idempotent step; retries with backoff; no heavy work in the DAG file at import time; backfills over explicit intervals.
- **Spark:** check partitioning and skew (`df.rdd.getNumPartitions()`, the Spark UI); avoid `collect()` on large data; broadcast small dimensions; write partitioned Parquet or Delta, not thousands of tiny files.
- **pandas or Polars locally** for data that fits in memory; DuckDB to query Parquet and CSV files directly with SQL.

## Modelling

Facts at a declared grain with foreign keys to conformed dimensions; slowly changing dimensions (type 2) where history matters; one definition per metric, documented where people will find it.

## Data quality

Check at every boundary: row counts against the source, sums of key measures, uniqueness of keys, null rates, freshness, referential integrity, and accepted ranges. A reconciliation query that compares source and target totals is the strongest proof a pipeline worked.

## Pitfalls

- Answering from a sample as if it were the whole table.
- Running an unbounded query on a production primary instead of a replica.
- Timezone shifts at month end, double-counting after a fan-out join, and a silent cast truncating values.
- `SELECT *` in pipelines: an upstream column change breaks or leaks data.

## Verification

Show the reconciliation (counts and sums, source against target), the tests that pass, and the query or command to reproduce them. Name any assumption about the grain or the business rules that the person should confirm.
