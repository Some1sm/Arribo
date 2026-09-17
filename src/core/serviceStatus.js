function serviceStatus(worker, reports, catalogReady, shuttingDown, now = Date.now()) {
  const age = value => Number.isFinite(value) && value > 0 && value <= now ? now - value : null;
  const upstream = worker.metrics?.upstream;
  const fleetAgeMs = age(upstream?.lastVehicleSuccessAt);
  const noticeAgeMs = age(worker.metrics?.noticesUpdatedAt);
  const ready = !!catalogReady && !!worker.isHealthy && !!worker.isRunning && !shuttingDown;
  const degraded = fleetAgeMs === null || fleetAgeMs > 60000;
  return {
    ready, status: shuttingDown ? 'stopping' : !ready ? 'starting' : degraded ? 'degraded' : 'ready',
    fleet: { fetchAgeMs: fleetAgeMs, observationAgeMs: age(worker.metrics?.lastObservationAt), fresh: fleetAgeMs !== null && fleetAgeMs <= 60000 },
    arrivals: { fetchAgeMs: age(upstream?.lastArrivalsSuccessAt) },
    notices: { ageMs: noticeAgeMs, fresh: noticeAgeMs !== null && noticeAgeMs <= 600000 },
    reports
  };
}
module.exports = serviceStatus;
