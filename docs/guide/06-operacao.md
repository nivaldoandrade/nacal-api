# 06 · Operação

Como colocar a API no ar, acompanhar o que está rodando e agir quando algo dá errado.

## Ambientes

| | dev | prod |
|---|---|---|
| Conta AWS | Pessoal (perfil `default`) | `nacal-prod`, numa AWS Organization (perfil `nacal-prod`, via Identity Center) |
| Stack | `nacal-api-dev` | `nacal-api-prod` (com termination protection) |
| Variáveis | `.env` | `.env.prod`, validado por `yarn check:prod` |
| Domínio | Endpoint padrão do API Gateway | `api.nacal.app` |
| Asaas | Sandbox | Produção |
| Alarmes | Criados, mas desligados | Ligados, com e-mail |
| Reconciliação | Desligada | Ligada |

O checklist da conta de produção (certificados, SES, Google, Asaas, CloudTrail, GuardDuty) é um documento interno, fora deste repo. Peça ao responsável pelo projeto.

## Deploy

```bash
# dev: stack inteira
sls deploy

# dev: só uma função (mais rápido, só código)
sls deploy function -f processMeal

# prod: valida o .env.prod e faz o deploy
AWS_PROFILE=nacal-prod yarn deploy:prod

# prod: só uma função
AWS_PROFILE=nacal-prod sls deploy function -f processMeal --stage prod
```

- `sls deploy function` **não** atualiza variáveis de ambiente, recursos nem rotas. Mudou qualquer coisa em `sls/` ou no `.env`: deploy completo.
- O Serverless v4 exige `sls login`.
- Antes do deploy: `yarn typecheck` e `npx eslint .` (não há testes automatizados).
- **Nunca rode `sls remove` em prod.** Em prod, há três camadas de proteção:
  - **Stack**: a termination protection do `nacal-api-prod` faz o `sls remove` falhar antes de apagar qualquer coisa. Ela foi ligada à mão (2026-11-11) e não está no `serverless.yml`.
  - **Dados**: as duas tabelas (`DeletionProtectionEnabled`) e o user pool (`DeletionProtection: ACTIVE`) recusam a exclusão. As três proteções valem só com a condição `IsProd`.
  - **Arquivos**: o bucket de refeições tem `DeletionPolicy: Retain` e sobrevive à remoção da stack, em qualquer stage.

  As tabelas e o user pool não têm `DeletionPolicy: Retain`. Se a termination protection for desligada, a remoção da stack falha nesses recursos em vez de preservá-los fora da stack, e o resto (Lambdas, filas, API Gateway, CloudFront) é apagado. Em dev nada disso está ligado, exceto o `Retain` do bucket.

## Alarmes

Todos publicam no tópico SNS `DQLAlarmTopic` (o nome é esse mesmo, com `DQL`, é como aparece no console), que manda e-mail para `DLQ_ALARM_EMAIL`. Só ficam ativos em prod.

| Alarme | Dispara quando | Significa | O que fazer |
|---|---|---|---|
| `MealsDLQAlarm` | Alguma mensagem na `MealsDLQ` | Uma refeição esgotou as 3 entregas sem conseguir nem marcar `FAILED` | Ver os logs da `processMeal` pelo `mealId` da mensagem. A refeição pode ter ficado presa sem estorno. |
| `MealsQueueAgeAlarm` | Mensagem mais antiga da `MealsQueue` passa de 2 min, por 2 min seguidos | O processamento está atrasado ou parado | Ver erros e throttling da `processMeal` e a disponibilidade da OpenAI |
| `MealUploadCheckDLQAlarm` | Alguma mensagem na `MealUploadCheckDLQ` | A checagem de 15 min falhou 3 vezes | Ver os logs da `checkMealUpload` e conferir a refeição e a cota na mão |
| `ReconcilePaymentsErrorsAlarm` | Erro na Lambda `reconcilePayments` | A reconciliação não rodou | Ver os logs. Ela roda de novo na hora seguinte. |
| E-mail "reconciliação encontrou divergências" | Pagamento ativado pela reconciliação, sem conta ou com erro | O webhook falhou ou um pagamento não tem dono | Ver [reconciliação](fluxos/billing-reconciliacao.md#o-e-mail-de-alerta) |
| GuardDuty (findings de severidade média para cima) | Atividade suspeita na conta | — | Configurado à mão em prod, fora do `serverless.yml` |

As DLQs guardam mensagens por 14 dias.

## Logs

```bash
sls logs -f processMeal --tail                   # dev
AWS_PROFILE=nacal-prod sls logs -f processMeal --stage prod --startTime 1h
```

Marcadores úteis para buscar no CloudWatch Logs Insights:

| Busca | Onde aparece | Mostra |
|---|---|---|
| `"meal_gate"` | `processMeal` | JSON com decisão, score, latência e tokens do gate |
| `"meal_gate_error"` | `processMeal` | Falha ou timeout do gate (a foto seguiu sem ele) |
| `[UNIDENTIFIED]` | `processMeal`, `createTextMeal`, `addMealItems` | Alimentos removidos por não estarem identificados |
| `[OPEN AI]` | Lambdas de refeição | Erro na chamada à OpenAI |
| `billing reconciliation` | `reconcilePayments` | Resumo de cada execução |
| `refund meal quota` | `createMeal`, `createTextMeal` | Estorno de cota que falhou na criação (conferir o contador na mão) |

## Runbooks e scripts

| Tarefa | Onde |
|---|---|
| Excluir a conta de um usuário (manual, durante o beta) | [Runbook de exclusão de conta](runbooks/exclusao-de-conta.md) |
| Convidar e-mails para o beta | README da API, seção "Convidar para o beta" (`scripts/sendBetaInvites.ts`) |
| Ver os e-mails transacionais renderizados | `npx tsx scripts/previewEmails.ts` (restrições do Cognito em [cadastro por e-mail](fluxos/auth-cadastro-email.md#e-mails)) |
| Criar refeições de teste pela API | `scripts/createMeal.ts`, `scripts/createTextMeal.ts` |
| Rodar a reconciliação na mão | [reconciliação](fluxos/billing-reconciliacao.md#rodar-na-mão) |

## Custos que valem vigiar

| Item | Por quê |
|---|---|
| OpenAI | É o maior custo variável. Cotas e rate limit existem para limitar esse gasto. |
| Cloudflare Workers AI | Gate de foto. Barato, mas cobrado por chamada. |
| GuardDuty | Grátis até 2026-12-12 em prod, depois cobrado. |
| CloudWatch Logs | O `serverless.yml` não define `logRetentionInDays`, então os logs das Lambdas nunca expiram. |

A estimativa de custos detalhada é um documento interno, fora deste repo.
