import { greeting, renderEmail } from '../emailLayout';

type ConfirmSignUpEmailParams = {
  code: string;
  name?: string;
};

export function confirmSignUpEmail({ code, name }: ConfirmSignUpEmailParams) {
  return renderEmail({
    subject: 'NaCal | Confirme seu e-mail',
    preheader: 'Use este código para confirmar seu e-mail e começar a usar o NaCal.',
    heading: 'Confirme seu e-mail',
    blocks: [
      { type: 'paragraph', text: greeting(name) },
      { type: 'paragraph', text: 'Falta pouco para começar a usar o NaCal. Digite este código no app para confirmar seu e-mail:' },
      { type: 'code', value: code },
      { type: 'note', text: 'O código vale por 24 horas.' },
      { type: 'note', text: 'Se você não criou uma conta no NaCal, pode ignorar este e-mail.' },
    ],
  });
}
