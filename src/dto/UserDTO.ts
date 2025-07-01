/**
 * User Data Transfer Objects
 */

export enum GenderType {
  MALE = "male",
  FEMALE = "female", 
  OTHER = "other"
}

export interface User {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  nickname: string;
  avatar?: string;
  auth_type: string;
  auth_provider: string;
  country?: string;
  city?: string;
  district?: string;
  ward?: string;
  lang?: string;
  gender?: GenderType;
  created_at?: Date;
  updated_at?: Date;
} 