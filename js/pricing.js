/* QueryCost default prices and model assumptions. Every number is editable in the app.
   List prices are public on-demand rates in each vendor's main US region, checked on PRICES_AS_OF. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.QC = root.QC || {}).pricing = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PRICES_AS_OF = '2026-10-30';
  const WAREHOUSES = [
    { id: 'bigquery', name: 'BigQuery', short: 'BQ', color: '#4285f4' },
    { id: 'snowflake', name: 'Snowflake', short: 'SF', color: '#29b5e8' },
    { id: 'databricks', name: 'Databricks SQL', short: 'DBX', color: '#ff3621' },
    { id: 'redshift', name: 'Redshift', short: 'RS', color: '#8c4fff' },
    { id: 'athena', name: 'Athena', short: 'ATH', color: '#e7157b' },
  ];
  const SOURCES = {
    bigquery: [{ label: 'BigQuery pricing (on-demand $/TiB, editions $/slot-hour, 10 MB minimums)', url: 'https://cloud.google.com/bigquery/pricing' },
      { label: 'Estimate and control costs (dry run is an upper bound)', url: 'https://cloud.google.com/bigquery/docs/best-practices-costs' }],
    snowflake: [{ label: 'Snowflake Service Consumption Table (credits/hour per size, $/credit by edition; effective Oct 29, 2026)', url: 'https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf' },
      { label: 'Snowflake pricing options', url: 'https://www.snowflake.com/en/pricing-options/' },
      { label: 'Warehouse billing: per second, 60-second minimum on resume', url: 'https://docs.snowflake.com/en/user-guide/warehouses-overview' }],
    databricks: [{ label: 'Databricks SQL pricing ($/DBU: Serverless, Pro, Classic)', url: 'https://www.databricks.com/product/pricing/databricks-sql' },
      { label: 'DBU per hour by SQL warehouse size', url: 'https://learn.microsoft.com/en-us/azure/databricks/resources/pricing' }],
    redshift: [{ label: 'Amazon Redshift pricing (Serverless $/RPU-hour, 60-second minimum; RA3 node-hours)', url: 'https://aws.amazon.com/redshift/pricing/' },
      { label: 'Billing for Redshift Serverless', url: 'https://docs.aws.amazon.com/redshift/latest/mgmt/serverless-billing.html' }],
    athena: [{ label: 'Amazon Athena pricing ($ per TB scanned, rounded up to MB, 10 MB minimum)', url: 'https://aws.amazon.com/athena/pricing/' }],
  };
  const SF_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
  const SF_CREDITS = { XS: 1, S: 2, M: 4, L: 8, XL: 16, '2XL': 32, '3XL': 64, '4XL': 128, '5XL': 256, '6XL': 512 };
  const DBX_SIZES = ['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large'];
  const DBX_DBU = { '2X-Small': 4, 'X-Small': 6, Small: 12, Medium: 24, Large: 40, 'X-Large': 80, '2X-Large': 144, '3X-Large': 272, '4X-Large': 528 };
  const RS_NODES = { 'ra3.large': 0.543, 'ra3.xlplus': 1.086, 'ra3.4xlarge': 3.26, 'ra3.16xlarge': 13.04 };
  const RS_NODE_GBPS = { 'ra3.large': 0.15, 'ra3.xlplus': 0.3, 'ra3.4xlarge': 0.9, 'ra3.16xlarge': 3.6 };
  function defaults() {
    return {
      asOf: PRICES_AS_OF,
      bigquery: { mode: 'ondemand', perTiB: 6.25, minTableMB: 10, minQueryMB: 10, freeTiB: 1, applyFreeTier: false, edition: 'enterprise',
        slotHour: { standard: 0.04, enterprise: 0.06, enterprise_plus: 0.10 }, slotSecPerGiB: 20, useClustering: true },
      snowflake: { size: 'XS', edition: 'enterprise', creditPrice: { standard: 2, enterprise: 3, business_critical: 4, vps: 6 }, credits: Object.assign({}, SF_CREDITS),
        gen2: false, gen2Multiplier: 1.35, gen2Speedup: 1.6, gbpsXS: 0.25, minSeconds: 60, coldStart: true, idleSeconds: 0 },
      databricks: { type: 'serverless', size: 'Small', dbuPrice: { serverless: 0.70, pro: 0.55, classic: 0.22 }, dbu: Object.assign({}, DBX_DBU),
        vmPerDbuHour: 0.312, gbpsPerDbu: 0.06, typeSpeed: { serverless: 1, pro: 0.9, classic: 0.6 }, idleSeconds: 0 },
      redshift: { mode: 'serverless', rpu: 32, rpuHour: 0.375, minSeconds: 60, applyMinimum: true, gbpsPerRpu: 0.04, idleSeconds: 0,
        nodeType: 'ra3.4xlarge', nodes: 2, nodePrice: Object.assign({}, RS_NODES), nodeGbps: Object.assign({}, RS_NODE_GBPS) },
      athena: { perTB: 5, minMB: 10 },
      model: { overheadSec: 1, joinFactor: 0.35, aggFactor: 0.15, sortFactor: 0.2, distinctFactor: 0.2, windowFactor: 0.25, countDistinctFactor: 0.3,
        explosionFactor: 2, crossJoinFactor: 10, correlatedFactor: 1.5,
        unknownRangeKeep: 0.25, clusterEqKeep: 0.1, clusterRangeKeep: 0.35, clusterSecondaryKeep: 0.8 },
    };
  }
  // Deep-merge saved settings over defaults so new fields appear after updates.
  function merge(saved) {
    const d = defaults();
    const rec = (a, b) => { if (!b || typeof b !== 'object') return a; Object.keys(a).forEach((k) => { if (b[k] == null) return; if (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) a[k] = rec(a[k], b[k]); else if (typeof a[k] === typeof b[k]) a[k] = b[k]; }); return a; };
    return rec(d, saved);
  }
  return { PRICES_AS_OF, WAREHOUSES, SOURCES, SF_SIZES, DBX_SIZES, RS_NODES, defaults, merge };
});
