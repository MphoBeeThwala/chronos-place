import { DomainError } from '@chronos/service-kit';

/**
 * Approximate location (CLAUDE.md rule 8, ADR-0023 decisions a and b).
 *
 * Points are snapped to a 0.01-degree grid before they are stored: about 1.1 km north to south
 * and about 1 km east to west at South African latitudes. Everyone in the same cell is stored at
 * the same point, so no query, log or breach can place a member more precisely than their cell.
 * Distances between snapped points are then rounded for display. Together these defeat the
 * trilateration attack, where someone fakes several positions and intersects the distances shown.
 */
export const GRID_DEGREES = 0.01;

export interface Point {
  latitude: number;
  longitude: number;
}

const INVALID_LOCATION = 'That location could not be used.';

const snapValue = (degrees: number) => Math.round(degrees / GRID_DEGREES) / (1 / GRID_DEGREES);

/** The grid point a location is stored as. Rejects anything that is not a real position. */
export function snap(point: Point): Point {
  const { latitude, longitude } = point;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new DomainError('invalid_argument', INVALID_LOCATION);
  }
  return { latitude: snapValue(latitude), longitude: snapValue(longitude) };
}

/**
 * The distance another member sees: whole kilometres and never less than 1, and above 10 km
 * rounded to the nearest 5 km (ADR-0023 decision a).
 */
export function displayDistanceKm(meters: number): number {
  const km = meters / 1000;
  if (km <= 10) return Math.max(1, Math.round(km));
  return Math.max(10, Math.round(km / 5) * 5);
}
