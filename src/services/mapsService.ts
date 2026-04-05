import { getRealDistance } from './geminiService';

export const VEHICLE_RATES = {
  "Bike": { base: 20, perKm: 6, description: "Quick & affordable bike rides", seats: 1 },
  "Auto": { base: 30, perKm: 10, description: "Classic Indian auto rickshaw", seats: 3 },
  "E-Rickshaw": { base: 25, perKm: 8, description: "Eco-friendly short distance travel", seats: 4 },
  "Mini (Non-AC)": { base: 35, perKm: 12, description: "Budget compact hatchback", seats: 4 },
  "Mini (AC)": { base: 45, perKm: 14, description: "Comfortable AC hatchback", seats: 4 },
  "Sedan (Non-AC)": { base: 45, perKm: 14, description: "Spacious non-AC sedan", seats: 4 },
  "Sedan (AC)": { base: 55, perKm: 16, description: "Premium AC sedan experience", seats: 4 },
  "SUV (Non-AC)": { base: 60, perKm: 18, description: "Large non-AC vehicle for groups", seats: 6 },
  "SUV (AC)": { base: 75, perKm: 22, description: "Spacious AC SUV for families", seats: 6 },
  "Eeco (7 Seater)": { base: 65, perKm: 16, description: "Economical 7-seater for small groups", seats: 7 },
  "Ertiga (9 Seater)": { base: 85, perKm: 24, description: "Spacious 9-seater family car", seats: 9 },
  "Bolero (7 Seater)": { base: 75, perKm: 20, description: "Rugged 7-seater for all terrains", seats: 7 },
  "Scorpio (7 Seater)": { base: 90, perKm: 25, description: "Premium 7-seater SUV", seats: 7 },
  "Sumo (10 Seater)": { base: 100, perKm: 28, description: "Large 10-seater for big groups", seats: 10 },
  "Tavera (10 Seater)": { base: 110, perKm: 30, description: "Comfortable 10-seater for long trips", seats: 10 },
  "Luxury (AC)": { base: 150, perKm: 40, description: "High-end luxury AC cars", seats: 4 },
  "Tempo (Non-AC)": { base: 100, perKm: 25, description: "12-seater for large groups", seats: 12 },
  "Tempo (AC)": { base: 150, perKm: 35, description: "Comfortable 12-seater AC tempo", seats: 12 },
  "Others": { base: 50, perKm: 15, description: "Other vehicle types", seats: 4 }
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
