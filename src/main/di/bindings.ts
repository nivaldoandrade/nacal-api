import { IPaymentGateway } from '@application/contracts/IPaymentGateway';
import { AsaasPaymentGateway } from '@infra/gateways/AsaasPaymentGateway';
import { Registry } from '@kernel/di/Registry';

Registry.getInstance().bind(IPaymentGateway, AsaasPaymentGateway);
