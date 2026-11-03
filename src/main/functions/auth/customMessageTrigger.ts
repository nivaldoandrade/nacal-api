import { CustomMessageTriggerEvent } from 'aws-lambda';

export async function handler(event: CustomMessageTriggerEvent) {
  const code = event.request.codeParameter;

  if (
    event.triggerSource === 'CustomMessage_SignUp'
    || event.triggerSource === 'CustomMessage_ResendCode'
  ) {
    event.response.emailSubject = 'NaCal | Confirme seu e-mail';
    event.response.emailMessage = [
      'Falta pouco para começar a usar a NaCal.',
      '',
      `Seu código de confirmação é: ${code}`,
      '',
      'Se você não criou esta conta, pode ignorar este e-mail.',
    ].join('\n');
  }

  if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    event.response.emailSubject = 'NaCal | Código de recuperação de conta';
    event.response.emailMessage = [
      'Recebemos um pedido para redefinir sua senha.',
      '',
      `Seu código de recuperação é: ${code}`,
      '',
      'Se não foi você, ignore este e-mail.',
    ].join('\n');
  }

  return event;
}
