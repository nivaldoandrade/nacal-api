import 'reflect-metadata';

import { ResendConfirmationCodeController } from '@application/controllers/auth/ResendConfirmationCodeController';
import { lambdaHttpAdapter } from '@main/adapters/lambdaHttpAdapter';

export const handler = lambdaHttpAdapter(ResendConfirmationCodeController);
