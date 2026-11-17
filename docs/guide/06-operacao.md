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

  As tabelas e o user pool não têm `DeletionPolicy: Retain`. Se a termination protection for desligada, a remoção da stack falha nesses recursos em vez de preservá-los fora da stack, e o resto (Lambdas, filas, API Gateway) é apagado. Em dev nada disso está ligado, exceto o `Retain` do bucket.

## Permissões e segredos por função

Cada Lambda tem o próprio papel IAM (`provider.iam.role.mode: perFunction` no `serverless.yml`), com o nome `nacal-api-<stage>-<função>-<região>-lambdaRole`. O Serverless põe sozinho a escrita no log group da função e, nas funções com evento SQS (`processMeal`, `checkMealUpload`), o `ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` da fila. O resto vem dos trechos de `sls/iam/statements.yml` que a função lista em `iam.role.statements` (`${self:custom.iam.<trecho>}`): leitura e escrita da tabela principal, tabela de rate limit, cada ação admin do Cognito, `PutObject`/`GetObject`/`DeleteObject` do bucket, envio para cada fila e publicação no `DQLAlarmTopic`.

Os segredos ficam só no `environment` das funções que os usam. O que não é segredo (tabelas, filas, URLs, flags) continua em `sls/config/env.yml`, para todas:

| Segredo | Funções |
|---|---|
| `COGNITO_CLIENT_SECRET` | `signUp`, `signIn`, `confirmSignUp`, `resendConfirmationCode`, `refreshToken`, `forgotPassword`, `confirmationForgotPassword`, `oauthCallback` |
| `ASAAS_API_KEY` | `checkout`, `cancel`, `webhookAsaas`, `reconcilePayments` |
| `ASAAS_WEBHOOK_TOKEN` | `webhookAsaas` |
| `OPENAI_API_KEY` | `processMeal`, `createTextMeal`, `addMealItems` |
| `CLOUDFLARE_AI_API_TOKEN` | `processMeal` |

Ao mudar o código:

- **Uma função passa a chamar algo novo da AWS** (outro repositório, outro método de gateway, um serviço compartilhado que cresceu): acrescente o trecho em **todas** as funções que chegam a esse código pela injeção de dependência, não só na do endpoint novo. Permissão faltando não quebra o deploy: aparece em runtime, com o `error.name` do SDK no log (`AccessDeniedException` no DynamoDB e no Cognito, `AccessDenied` no S3; no `HeadObject` o `403` aparece como `Unknown`). Nas funções HTTP vira `500`; nos consumidores de fila e no trigger do S3 vira erro da invocação, com novas tentativas e, nas filas, mensagem na DLQ. A tabela de rate limit só é usada por controllers com `@RateLimit` e por quem consome ou estorna cota (`MealQuotaService`, `failAndRefund`/`rejectAndRefund`).
- **Uma função passa a usar um segredo**: ponha a variável no `environment` dela. O `COGNITO_CLIENT_SECRET`, o `ASAAS_API_KEY` e o `ASAAS_WEBHOOK_TOKEN` são opcionais no `env.ts` e são cobrados só quando o código os lê (getters do `AppConfig`). Sem a variável, a request falha com `Error: <NOME> is not configured for this function.`. O SDK da OpenAI lê `OPENAI_API_KEY` sozinho e falha ao criar o `MealAiGateway`. Segredo novo segue o mesmo padrão: opcional no `env.ts` e getter com `requireSecret` no `AppConfig`.
- **Função nova**: declare o `iam.role.statements` dela. Sem esse bloco ela recebe só os logs. O nome do papel tem limite de 64 caracteres e o de prod mais longo hoje tem 62 (`nacal-api-prod-confirmationForgotPassword-sa-east-1-lambdaRole`): uma função com nome de 29 caracteres ou mais quebra o deploy de prod, a menos que ganhe um `iam.role.name` mais curto.
- **Conferir antes do deploy**: `sls package` gera `.serverless/cloudformation-template-update-stack.json`, com um recurso `<Função>IamRoleLambdaExecution` por função e as variáveis em `<Função>LambdaFunction.Properties.Environment`.

Valor faltando no `.env` ou no `.env.prod` continua quebrando cedo: `${env:...}` sem valor padrão faz o `sls deploy` falhar, e o `check:prod` valida o `.env.prod`.

## Alarmes

Todos publicam no tópico SNS `DQLAlarmTopic` (o nome é esse mesmo, com `DQL`, é como aparece no console), que manda e-mail para `DLQ_ALARM_EMAIL`. Os alarmes do CloudWatch só ficam ativos em prod; os alertas do código (estorno e chargeback, pagamento de outra assinatura, reconciliação) também saem em dev. O que fazer com cada e-mail, com exemplos e comandos: [runbook de alertas](runbooks/alertas.md).

| Alarme | Dispara quando | Significa | O que fazer |
|---|---|---|---|
| `MealsDLQAlarm` | Alguma mensagem na `MealsDLQ` | Uma refeição esgotou as 3 entregas sem conseguir nem marcar `FAILED` | Ver os logs da `processMeal` pelo `mealId` da mensagem. A refeição pode ter ficado presa sem estorno. |
| `MealsQueueAgeAlarm` | Mensagem mais antiga da `MealsQueue` passa de 2 min, por 2 min seguidos | O processamento está atrasado ou parado, ou a fila passou do que o `maximumConcurrency: 5` dá conta (uma rajada de ~20 refeições ou mais) | Ver erros e throttling da `processMeal`, a disponibilidade da OpenAI e a `ConcurrentExecutions` da `processMeal` (parada em 5 = limite do evento SQS) |
| `MealUploadCheckDLQAlarm` | Alguma mensagem na `MealUploadCheckDLQ` | A checagem de 15 min falhou 3 vezes | Ver os logs da `checkMealUpload` e conferir a refeição e a cota na mão |
| `ReconcilePaymentsErrorsAlarm` | Erro na Lambda `reconcilePayments` | A reconciliação não rodou | Ver os logs. Ela roda de novo na hora seguinte. |
| `HttpApi5xxAlarm` | 3 ou mais respostas `5xx` do HTTP API em 5 min | Erro não tratado, `502` do Asaas ou do Cognito, Lambda com timeout | Ver [runbook de alertas](runbooks/alertas.md#httpapi5xxalarm) |
| `AsaasWebhookNon2xxAlarm` | 1 ou mais respostas não-2xx dadas pelo código do webhook do Asaas em 5 min (métrica `WebhookNon2xx`) | IP fora da allowlist, token errado, conflito de escrita ou erro. Throttle (`reservedConcurrency: 5`), timeout ou erro de init não passam pelo código: só aparecem no `HttpApi5xxAlarm` | Ver [runbook de alertas](runbooks/alertas.md#asaaswebhooknon2xxalarm). O Asaas pausa a fila do webhook depois de 15 falhas seguidas |
| `MealFailedAlarm` | 1 ou mais refeições `FAILED` em 15 min (métrica `MealFailed`) | Uma refeição foi perdida (a cota já foi estornada) | Ver [runbook de alertas](runbooks/alertas.md#mealfailedalarm) |
| `NewMealUploadedTriggerErrorsAlarm` | 1 ou mais erros da `newMealUploadedTrigger` em 5 min (conta cada tentativa, inclusive as que dão certo na repetição) | O evento de upload do S3 não virou mensagem na `MealsQueue` | Ver [runbook de alertas](runbooks/alertas.md#newmealuploadedtriggererrorsalarm) |
| `ProcessMealThrottlesAlarm` | 1 ou mais throttles da `processMeal` em 5 min | A conta bateu o limite de concorrência das Lambdas | Ver [runbook de alertas](runbooks/alertas.md#processmealthrottlesalarm) |
| E-mail "reconciliação encontrou divergências" | Pagamento ativado ou estorno aplicado pela reconciliação, sem conta ou com erro | O webhook falhou ou um pagamento não tem dono | Ver [runbook de alertas](runbooks/alertas.md#reconciliação-encontrou-divergências) |
| E-mail "estorno ... · Pro descontado/sem mudança" | Evento de estorno ou chargeback no webhook do Asaas | O Pro foi descontado ou não, conforme o caso | Ver [runbook de alertas](runbooks/alertas.md#estorno-e-chargeback) |
| E-mail "pagamento de outra assinatura com o Pro ativo" | Pagamento que não é da assinatura guardada | Pode haver duas cobranças ativas | Ver [runbook de alertas](runbooks/alertas.md#pagamento-de-outra-assinatura-com-o-pro-ativo) |
| GuardDuty (findings de severidade média para cima) | Atividade suspeita na conta | — | Configurado à mão em prod, fora do `serverless.yml` |

As DLQs guardam mensagens por 14 dias.

## Logs

```bash
sls logs -f processMeal --tail                   # dev
AWS_PROFILE=nacal-prod sls logs -f processMeal --stage prod --startTime 1h
```

- **Formato**: uma linha JSON por evento, com `timestamp`, `level` (`INFO`, `WARN`, `ERROR`), `message` e os campos do contexto (`awsRequestId`, `routeKey`, `accountId`, `messageId`, `mealId`). Detalhes em [arquitetura](02-arquitetura-codigo.md#logger). As linhas de início e fim da Lambda (`START`, `END`, `REPORT`) continuam em texto.
- **Retenção**: 30 dias em todos os log groups (`provider.logRetentionInDays`).
- **Access log do HTTP API**: `/aws/http-api/nacal-api-<stage>`, uma linha por request com IP, rota e status. Mostra também o que não chega na Lambda (`401` do authorizer, rota inexistente).
- **Sourcemaps**: o build gera `.js.map` (sem o código-fonte embutido) e o Serverless põe `NODE_OPTIONS=--enable-source-maps` em cada função, então a stack de um erro aponta para o arquivo e a linha do `src/`. O `keepNames` do esbuild mantém o nome das classes de erro (`error.name` sai `BillingError`, não o nome minificado).

Marcadores úteis para buscar no CloudWatch Logs Insights (campo `message`):

| `message` | Onde aparece | Mostra |
|---|---|---|
| `http request` | Lambdas HTTP | Uma linha por request: `routeKey`, `statusCode`, `durationMs`, `errorCode` e, nos `5xx`, o `error` |
| `sqs message failed` | `processMeal`, `checkMealUpload` | Mensagem que voltou para a fila, com `messageId`, `receiveCount` e o `error` |
| `meal processing started`, `meal processed`, `meal rejected`, `meal processing attempt failed` | `processMeal` | Transições de uma refeição, com `mealId`, `attempt` e `durationMs` |
| `metric MealFailed` | `processMeal`, `checkMealUpload` | Refeição que virou `FAILED`, com o `source` |
| `metric WebhookNon2xx` | `webhookAsaas` | Resposta não-2xx do webhook, com `statusCode` e `errorCode` |
| `openai response` | Lambdas de refeição | `usage` de cada chamada à OpenAI (`inputTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens`), `operation`, `responseStatus` e `durationMs` |
| `openai transcription` | `processMeal` | Transcrição do áudio, com `usage` e `durationMs` |
| `meal_gate` | `processMeal` | Decisão, score, latência e tokens do gate |
| `meal_gate_error` | `processMeal` | Falha ou timeout do gate (a foto seguiu sem ele) |
| `unidentified foods removed` | `processMeal`, `createTextMeal`, `addMealItems` | Alimentos removidos por não estarem identificados |
| `billing reconciliation` | `reconcilePayments` | Resumo de cada execução |
| `failed to refund meal quota` | `createMeal` | Estorno de cota que falhou na criação (conferir o contador na mão). No `createTextMeal`, a mesma falha sai no `error` da linha `http request` do `500` (`AggregateError` com "refund meal quota") |

Exemplo no Logs Insights (tokens por operação na última semana):

```text
fields operation, usage.inputTokens, usage.cachedTokens, usage.outputTokens, usage.reasoningTokens
| filter message = "openai response"
| stats count() as calls, avg(usage.inputTokens) as input, avg(usage.cachedTokens) as cached, avg(usage.outputTokens) as output, max(usage.outputTokens) as maxOutput, max(usage.reasoningTokens) as maxReasoning by operation
```

Como ler: `maxOutput` deve ficar bem abaixo do `max_output_tokens` (2048; 30 itens, o máximo do schema, dão ~1.100–1.200), e `maxReasoning` em 0 (`reasoning.effort: none`). Se aparecer `responseStatus` `incomplete`, o motivo está no `incompleteReason` da mesma linha (ex.: `max_output_tokens`), e o erro da tentativa sai como `OPEN AI incomplete response`. `cached` baixo em relação a `input` com tráfego espaçado é esperado: o cache da OpenAI expira com 5–10 min sem uso. Preço do `gpt-5.4-mini` (2026-11-17, por milhão de tokens): US$ 0,75 de entrada, US$ 0,075 de entrada em cache e US$ 4,50 de saída; uma foto custa ~US$ 0,0043 sem cache e ~US$ 0,0019 com o prompt em cache.

Cold start, duração e memória por função (selecione os grupos `/aws/lambda/nacal-api-<stage>-<função>` que quiser comparar):

```text
filter @type = "REPORT"
| parse @log /nacal-api-[a-z]+-(?<fn>[A-Za-z]+)$/
| stats count(*) as n, count(@initDuration) as cold, pct(@initDuration, 50) as init50, pct(@initDuration, 90) as init90, pct(@duration, 50) as d50, pct(@duration, 90) as d90, max(@maxMemoryUsed) / 1000000 as maxMemMB, max(@memorySize) / 1000000 as sizeMB by fn
```

Como ler: `maxMemMB` perto de `sizeMB` é risco de estourar a memória; foi o motivo de subir o padrão de 128 para 256 MB (tabela de memória em [01-visao-geral.md](01-visao-geral.md)). O `@initDuration` só aparece nas invocações com cold start (`cold`).

## Runbooks e scripts

| Tarefa | Onde |
|---|---|
| Excluir a conta de um usuário (manual, durante o beta) | [Runbook de exclusão de conta](runbooks/exclusao-de-conta.md) |
| Entender um e-mail de alerta, encerrar ou devolver o Pro à mão | [Runbook de alertas](runbooks/alertas.md) |
| Convidar e-mails para o beta | README da API, seção "Convidar para o beta" (`scripts/sendBetaInvites.ts`) |
| Ver os e-mails transacionais renderizados | `npx tsx scripts/previewEmails.ts` (restrições do Cognito em [cadastro por e-mail](fluxos/auth-cadastro-email.md#e-mails)) |
| Criar refeições de teste pela API | `scripts/createMeal.ts`, `scripts/createTextMeal.ts` |
| Rodar a reconciliação na mão | [reconciliação](fluxos/billing-reconciliacao.md#rodar-na-mão) |

## Custos que valem vigiar

| Item | Por quê |
|---|---|
| OpenAI | É o maior custo variável. Cotas, rate limit, o teto de 5 rejeições estornadas por dia por conta e o `maximumConcurrency: 5` da `processMeal` existem para limitar esse gasto. Para ver quantas rejeições ficaram sem estorno: Logs Insights na `processMeal` com `filter message = "meal rejected" | stats count() by refunded, reason`. |
| Cloudflare Workers AI | Gate de foto. Barato, mas cobrado por chamada. |
| GuardDuty | Grátis até 2026-12-12 em prod, depois cobrado. |
| Throttling do HTTP API | `DefaultRouteSettings` com 50 req/s e burst de 100 **por rota** (`sls/resources/httpApiStage.yml`). Não custa nada, mas corta tráfego legítimo se o uso crescer: conferir a métrica `Count` por rota antes de chegar perto e subir o valor. O `429` do stage aparece no access log (`status: 429`), sem linha `http request` da Lambda. |
| CloudWatch Logs | Ingestão por GB. Retenção de 30 dias (`logRetentionInDays`); as linhas por request e o access log crescem com o tráfego. |
| CloudWatch (alarmes e métricas) | 8 alarmes e 2 métricas EMF (`MealFailed`, `WebhookNon2xx`) custam centavos por mês. |

A estimativa de custos detalhada é um documento interno, fora deste repo.
