import 'reflect-metadata';

import { ConfirmSignUpController } from '@application/controllers/auth/ConfirmSignUpController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(ConfirmSignUpController);
