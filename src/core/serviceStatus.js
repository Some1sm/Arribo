function serviceStatus(worker, reports, catalogReady, shuttingDown, now = Date.now()) {
  const age = value => Number.isFinite(value) && value > 0 && value <= now ? now - value : null;
  const upstream = worker.metrics?.upstream;
  const fleetAgeMs = age(upstream?.lastVehicleSuccessAt);
  const noticeAgeMs = age(worker.metrics?.noticesUpdatedAt);
  const canary = worker.metrics?.upstreamCanary;
  const canaryAgeMs = canary?.checkedAt ? age(canary.checkedAt) : null;
  const canaryFailed = Boolean(canary && !canary.ok && (canaryAgeMs !== null && canaryAgeMs < 15 * 60 * 1000));
  const fleetAnomaly = worker.metrics?.fleetAnomaly || null;

  const ready = !!catalogReady && !!worker.isHealthy && !!worker.isRunning && !shuttingDown;
  const degraded = fleetAgeMs === null || fleetAgeMs > 60000 || canaryFailed || Boolean(fleetAnomaly);
  return {
    ready, status: shuttingDown ? 'stopping' : !ready ? 'starting' : degraded ? 'degraded' : 'ready',
    fleet: {
      fetchAgeMs: fleetAgeMs,
      observationAgeMs: age(worker.metrics?.lastObservationAt),
      fresh: fleetAgeMs !== null && fleetAgeMs <= 60000,
      anomaly: fleetAnomaly
    },
    arrivals: { fetchAgeMs: age(upstream?.lastArrivalsSuccessAt) },
    notices: { ageMs: noticeAgeMs, fresh: noticeAgeMs !== null && noticeAgeMs <= 600000 },
    upstream: {
      canaryOk: canary ? Boolean(canary.ok) : null,
      canaryError: canary ? (canary.error || null) : null,
      canaryCheckedAt: canary ? (canary.checkedAt || null) : null
    },
    reports
  };
}
module.exports = serviceStatus;
