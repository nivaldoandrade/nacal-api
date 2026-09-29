import { CustomMessageTriggerEvent } from 'aws-lambda';

export async function handler(event: CustomMessageTriggerEvent) {

  const code = event.request.codeParameter;

  if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    event.response.emailSubject = '🥬 NaCal | Código de recuperação de conta';
    event.response.emailMessage = `O código de recuperação: ${code}`;
  }

  return event;
}
