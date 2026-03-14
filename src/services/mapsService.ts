import { getRealDistance } from './geminiService';

export const VEHICLE_RATES = {
  Mini: { base: 50, perKm: 19, description: "Compact cars for city travel" },
  Sedan: { base: 80, perKm: 20, description: "Comfortable sedans for business" },
  SUV: { base: 120, perKm: 22, description: "Large vehicles for families" },
  Luxury: { base: 250, perKm: 45, description: "Premium luxury experience" }
};

export interface FareOption {
  type: string;
  fare: number;
  description: string;
}

export async function calculateRealFare(pickup: string, dropoff: string, tripType: 'single' | 'round', manualDistance?: number) {
  const calculateOptions = (distanceKm: number) => {
    const multiplier = tripType === 'round' ? (2 * 0.90) : 1;
    return Object.entries(VEHICLE_RATES).map(([type, rates]) => {
      let currentPerKm = rates.perKm;
      
      // Special rule: If distance > 100km, Mini and SUV are ₹19/km
      if (distanceKm > 100) {
        if (type === 'Mini' || type === 'SUV') {
          currentPerKm = 19;
        }
      }

      return {
        type,
        fare: Math.round((rates.base + (distanceKm * currentPerKm)) * multiplier),
        description: rates.description
      };
    });
  };

  if (manualDistance !== undefined && manualDistance > 0) {
    return {
      distance: manualDistance,
      options: calculateOptions(manualDistance)
    };
  }

  if (!window.google) {
    console.warn("Google Maps not loaded, falling back to Gemini for distance");
    const distance = await getRealDistance(pickup, dropoff);
    return {
      distance,
      options: calculateOptions(distance)
    };
  }

  const service = new google.maps.DistanceMatrixService();
  
  return new Promise<{ distance: number; options: FareOption[] }>((resolve) => {
    service.getDistanceMatrix(
      {
        origins: [pickup],
        destinations: [dropoff],
        travelMode: google.maps.TravelMode.DRIVING,
        unitSystem: google.maps.UnitSystem.METRIC,
      },
      async (response, status) => {
        if (status !== "OK" || !response || !response.rows[0].elements[0] || response.rows[0].elements[0].status !== "OK") {
          console.warn("Distance Matrix failed, falling back to Gemini:", status);
          const distance = await getRealDistance(pickup, dropoff);
          resolve({
            distance,
            options: calculateOptions(distance)
          });
          return;
        }

        const element = response.rows[0].elements[0];
        const distanceKm = element.distance.value / 1000;
        
        resolve({
          distance: parseFloat(distanceKm.toFixed(1)),
          options: calculateOptions(distanceKm)
        });
      }
    );
  });
}
