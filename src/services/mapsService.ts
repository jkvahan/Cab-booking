import { getRealDistance } from './geminiService';

export const VEHICLE_RATES = {
  Mini: { base: 50, perKm: 19, description: "Compact cars for city travel", seats: 4 },
  Sedan: { base: 80, perKm: 20, description: "Comfortable sedans for business", seats: 4 },
  SUV: { base: 120, perKm: 22, description: "Large vehicles for families", seats: 7 },
  Sumo: { base: 150, perKm: 24, description: "Reliable multi-utility vehicle", seats: 10 },
  Tavera: { base: 150, perKm: 24, description: "Spacious MUV for groups", seats: 10 },
  Tempo: { base: 300, perKm: 35, description: "Large traveler for big groups", seats: 16 },
  Luxury: { base: 250, perKm: 45, description: "Premium luxury experience", seats: 4 }
};

export interface FareOption {
  type: string;
  fare: number;
  description: string;
  seats: number;
  discount?: number;
}

export async function calculateRealFare(
  pickup: string, 
  dropoff: string, 
  tripType: 'single' | 'round', 
  manualDistance?: number,
  consecutiveCancellations: number = 0
) {
  const calculateOptions = (distanceKm: number) => {
    const baseMultiplier = tripType === 'round' ? (2 * 0.90) : 1;
    const standardMultiplier = tripType === 'round' ? 2 : 1;
    
    // Cancellation Penalty: 2% for each consecutive cancellation
    const penaltyMultiplier = 1 + (consecutiveCancellations * 0.02);
    
    // Round Trip Discount: 1% for every 140km if distance >= 140km
    // But ONLY if there are NO cancellations
    let discountMultiplier = 1;
    if (tripType === 'round' && distanceKm >= 140 && consecutiveCancellations === 0) {
      const discountPercent = Math.floor(distanceKm / 140) * 0.01;
      discountMultiplier = 1 - discountPercent;
    }

    return Object.entries(VEHICLE_RATES).map(([type, rates]) => {
      let currentPerKm = rates.perKm;
      
      // Special rule: If distance > 100km, Mini and SUV are ₹19/km
      if (distanceKm > 100) {
        if (type === 'Mini' || type === 'SUV') {
          currentPerKm = 19;
        }
      }

      const standardFare = (rates.base + (distanceKm * currentPerKm)) * standardMultiplier;
      const baseFare = (rates.base + (distanceKm * currentPerKm)) * baseMultiplier;
      const finalFare = Math.round(baseFare * penaltyMultiplier * discountMultiplier);
      const discount = Math.max(0, Math.round(standardFare - finalFare));

      return {
        type,
        fare: finalFare,
        discount,
        description: rates.description,
        seats: (rates as any).seats
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
