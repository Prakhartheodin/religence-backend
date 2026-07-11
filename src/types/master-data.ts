export interface SaltMasterModel {
  id: string;
  name: string;
  casNumbers: string[];
  sourceFiles: string[];
  buyerCount: number;
  totalAnnualBuyingCapacityKg: number;
  companyCategories: string[];
  countries: string[];
  certifications: string[];
}

export interface MedicineMasterModel {
  id: string;
  saltId: string;
  name: string;
  dosageForm: string;
  casNumber: string | null;
  sourceFiles: string[];
  buyerCount: number;
  totalAnnualBuyingCapacityKg: number;
}

export interface BuyerMasterModel {
  id: string;
  medicineId: string;
  saltId: string;
  productName: string;
  casNo: string | null;
  buyerName: string;
  companyCategory: string | null;
  certifications: string[];
  annualBuyingCapacityKg: number | null;
  contactPersons: string[];
  designations: string[];
  emails: string[];
  phoneNumbers: string[];
  country: string | null;
  sourceFile: string;
  sourceRow: number;
}

export interface MasterDataModel {
  generatedAt: string;
  sourceDirectory: string;
  sourceFiles: string[];
  salts: SaltMasterModel[];
  medicines: MedicineMasterModel[];
  buyers: BuyerMasterModel[];
}
