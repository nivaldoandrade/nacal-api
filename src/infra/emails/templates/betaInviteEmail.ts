import { renderEmail } from '../emailLayout';

const APP_URL = 'https://app.nacal.app';

export function betaInviteEmail() {
  return renderEmail({
    subject: 'NaCal | Seu convite para o beta chegou',
    preheader: 'Sua vaga no beta do NaCal está liberada. Crie sua conta e registre a primeira refeição.',
    heading: 'Sua vaga no beta está liberada',
    footerReason: 'Você recebeu este e-mail porque entrou na lista de espera do NaCal.',
    blocks: [
      { type: 'paragraph', text: 'Oi! Você entrou na lista de espera do NaCal e agora pode usar o app.' },
      { type: 'button', text: 'Criar minha conta', href: APP_URL },
      { type: 'paragraph', text: 'Use este mesmo e-mail para criar a conta. Se ele for um Gmail, também dá para entrar com o Google.' },
      { type: 'paragraph', text: 'Para ter o NaCal na tela inicial do celular: no iPhone, abra o link no Safari, toque em Compartilhar e depois em "Adicionar à Tela de Início". No Android, abra no Chrome e toque em "Instalar app".' },
      { type: 'note', text: 'É um beta: os números são estimativas e alguma coisa pode falhar. Se algo parecer estranho, conta pra gente.' },
      { type: 'note', text: 'Responda este e-mail com o que achou. A gente lê tudo.' },
    ],
  });
}
