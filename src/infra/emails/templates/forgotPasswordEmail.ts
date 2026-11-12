import { greeting, renderEmail } from '../emailLayout';

type ForgotPasswordEmailParams = {
  code: string;
  name?: string;
};

export function forgotPasswordEmail({ code, name }: ForgotPasswordEmailParams) {
  return renderEmail({
    subject: 'NaCal | Código para redefinir sua senha',
    preheader: 'Use este código para criar uma nova senha no NaCal.',
    heading: 'Redefina sua senha',
    blocks: [
      { type: 'paragraph', text: greeting(name) },
      { type: 'paragraph', text: 'Recebemos um pedido para redefinir a senha da sua conta no NaCal. Digite este código no app para criar uma nova senha:' },
      { type: 'code', value: code },
      { type: 'note', text: 'O código vale por 1 hora.' },
      { type: 'note', text: 'Se não foi você, pode ignorar este e-mail. Sua senha continua a mesma.' },
    ],
  });
}
