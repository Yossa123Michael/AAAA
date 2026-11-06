export interface CommissionInput {
  itemType: 'SERVICE' | 'PRODUCT';
  grossPrice: number;
  discountAmount: number;
  customRate?: number;
  barberLevel?: string;
}

export class CommissionService {
  public static calculateItem(input: CommissionInput) {
    const calculationBase = input.grossPrice - input.discountAmount;
    let rate = 0;

    if (input.customRate !== undefined && input.customRate !== null) {
      rate = input.customRate;
    } else if (input.itemType === 'PRODUCT') {
      rate = 10.0; // Default komisi produk retail 10%
    } else {
      // Fallback level barber
      switch (input.barberLevel) {
        case 'MASTER': rate = 45.0; break;
        case 'SENIOR': rate = 40.0; break;
        case 'JUNIOR': rate = 30.0; break;
        default: rate = 35.0;
      }
    }

    const commissionAmount = Math.round((calculationBase * rate) / 100);
    return { calculationBase, rateApplied: rate, commissionAmount };
  }
}