import { PublishCommand } from '@aws-sdk/client-sns';
import { snsClient } from '@infra/clients/snsClient';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class AlertGateway {

  constructor(private readonly config: AppConfig) { }

  async publish({ subject, message }: AlertGateway.PublishParams): Promise<void> {
    const { topicArn } = this.config.alerts;

    if (!topicArn) {
      // eslint-disable-next-line no-console
      console.error(`[alert] ${subject}\n${message}`);

      return;
    }

    const command = new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 99),
      Message: message,
    });

    await snsClient.send(command);
  }
}

export namespace AlertGateway {
  export type PublishParams = {
    subject: string;
    message: string;
  };
}
