# Fluxo: planos, trial, checkout e webhook (billing)

## Resumo

O plano pago (Pro) é cobrado pelo **Asaas**. O app pede um link de checkout, o usuário paga na página do Asaas e o **webhook** do Asaas é a fonte da verdade: só ele ativa ou renova a assinatura. A API nunca confia no retorno do navegador. Uma [reconciliação horária](billing-reconciliacao.md) cobre webhooks perdidos.

Os use cases não conhecem o Asaas: falam com o contrato `IPaymentGateway`, ligado ao `AsaasPaymentGateway` em `src/main/di/bindings.ts`.

| Ação | Rota | Lambda |
|---|---|---|
| Listar planos | 🔒 `GET /billing/plans` | `plans` |
| Começar o trial | 🔒 `POST /billing/trial` (5 por hora por conta) | `trial` |
| Criar checkout | 🔒 `POST /billing/checkout` com `{ planId, returnUrl }` (10 por hora por conta) | `checkout` |
| Cancelar | 🔒 `POST /billing/cancel` (10 por hora por conta) | `cancel` |
| Webhook do Asaas | `POST /billing/webhooks/asaas` (token + allowlist de IP, 120 por minuto por IP) | `webhookAsaas` |
| Reconciliação | Schedule de 1 h | `reconcilePayments` |

## Planos

| Plano | Preço | Cobrança no Asaas | Pagamento |
|---|---|---|---|
| Free | — | — | 20 refeições com IA por mês |
| `PRO_MONTHLY` | R$ 9,99 por mês | Assinatura recorrente (`RECURRENT`) | Só cartão |
| `PRO_YEARLY` | R$ 89,90 por ano | Cobrança avulsa (`DETACHED`), renovada pelo usuário | Pix ou cartão |

Pro: até 20 refeições com IA por dia. Trial: 7 dias de Pro, uma vez por conta. Os valores ficam em `Subscription.Plan` (`src/application/entities/Subscription.ts`).

## Estados da assinatura

```mermaid
stateDiagram-v2
    [*] --> TRIALING: POST /billing/trial<br/>só se nunca teve assinatura
    [*] --> ACTIVE: webhook PAYMENT_SUCCEEDED

    TRIALING --> ACTIVE: webhook PAYMENT_SUCCEEDED
    TRIALING --> CANCELED: POST /billing/cancel<br/>perde o Pro na hora

    ACTIVE --> ACTIVE: PAYMENT_SUCCEEDED<br/>paidUntil avança um ciclo
    ACTIVE --> PAST_DUE: webhook PAYMENT_OVERDUE
    PAST_DUE --> ACTIVE: webhook PAYMENT_SUCCEEDED

    ACTIVE --> CANCELED: POST /billing/cancel<br/>ou SUBSCRIPTION_CANCELED
    PAST_DUE --> CANCELED: POST /billing/cancel<br/>ou SUBSCRIPTION_CANCELED<br/>ou checkout com o Pro já vencido

    ACTIVE --> CANCELED: estorno total ou chargeback<br/>do ciclo atual
    PAST_DUE --> CANCELED: estorno total ou chargeback<br/>do ciclo atual

    CANCELED --> CANCELED: pagamento da mesma assinatura<br/>só estende o paidUntil
    CANCELED --> ACTIVE: novo checkout pago
```

O estorno do anual com renovação adiantada só volta o `paidUntil` um ano e mantém `ACTIVE` enquanto o ano anterior ainda vale (ver [Estorno e chargeback](#estorno-e-chargeback)).

Os webhooks `PAYMENT_OVERDUE` e `SUBSCRIPTION_CANCELED` valem para **qualquer status diferente de `CANCELED`**, inclusive `TRIALING`, desde que sejam da assinatura do Asaas guardada em `gatewayRefs.subscriptionId` (ou que um dos dois lados não tenha referência). O diagrama mostra só os casos comuns.

O **status não decide sozinho** se o usuário é Pro. Quem decide é `Subscription.resolveEffectivePlan`, chamado em toda criação de refeição e no `GET /me`:

| Status | É Pro enquanto... |
|---|---|
| `TRIALING` | `trialEndsAt` não passou |
| `ACTIVE` ou `PAST_DUE` | `paidUntil` + 3 dias de carência (`GRACE_DAYS`) não passou |
| `CANCELED` | `paidUntil` não passou: quem cancela continua Pro até o fim do que pagou |
| `EXPIRED` ou sem assinatura | Nunca: é Free |

Por isso não existe job que "expira" assinaturas: o plano é calculado na hora, a partir das datas. O status `EXPIRED` existe no tipo, mas nenhum fluxo o grava hoje.

## Checkout e ativação

```mermaid
sequenceDiagram
    autonumber
    actor U as App
    participant API as checkout
    participant As as Asaas
    participant DB as MainTable
    participant W as webhookAsaas
    participant RL as RateLimitTable

    U->>API: POST /billing/checkout com planId e returnUrl
    API->>API: returnUrl é do app web ou nacal://?
    API->>DB: lê a Subscription
    alt mensal ACTIVE ainda Pro, outro ciclo com Pro pago ou anual com mais de 31 dias
        API-->>U: 409 SUBSCRIPTION_ALREADY_ACTIVE
    else mensal PAST_DUE ainda Pro
        API->>As: GET /v3/subscriptions/{id}/payments, vencida ou pendente
        API-->>U: 200 com o invoiceUrl e type INVOICE
    else mensal ACTIVE ou PAST_DUE com o Pro vencido
        API->>As: DELETE /v3/subscriptions/{id}
        API->>DB: Subscription CANCELED (escrita condicional) e segue para o checkout
    end
    API->>DB: PENDING_CHECKOUT#accountId existe, do mesmo plano e returnUrl, com mais de 10 min?
    alt existe
        API-->>U: 200 com o mesmo checkoutUrl
    end
    API->>As: POST /v3/checkouts com externalReference accountId#planId, expira em 60 min
    As-->>API: checkoutId e link
    API->>DB: GATEWAY#checkoutId aponta para accountId e planId
    API->>DB: PENDING_CHECKOUT#accountId com o link, TTL de 60 min
    API-->>U: 200 com checkoutUrl, expiresAt e type CHECKOUT
    U->>As: abre o checkout no navegador e paga
    As-->>U: redireciona para o returnUrl
    Note over U: o app não ativa nada aqui,<br/>só passa a consultar o GET /me

    As->>W: POST webhook com header asaas-access-token
    W->>W: IP na allowlist? token confere?
    W->>RL: evento já processado?
    alt já processado
        W-->>As: 200
    end
    W->>W: descobre accountId e planId pelo externalReference<br/>ou pelos itens GATEWAY#
    W->>DB: GATEWAY#subscriptionId aponta para a conta
    W->>DB: cria ou atualiza a Subscription: ACTIVE e paidUntil
    W->>RL: marca o evento como processado, TTL de 14 dias
    W-->>As: 200 com received true
```

### Passo a passo do checkout

1. Valida o `planId` e o `returnUrl`: ele tem que ser o `APP_WEB_URL` (ou um caminho dentro dele) ou começar com `nacal://` (app nativo). Isso evita usar o checkout para mandar o usuário para um site qualquer.
2. **Confere a assinatura atual**, para nunca nascer uma segunda assinatura no Asaas cobrando junto com a primeira. Só `ACTIVE` e `PAST_DUE` entram nesta regra; sem assinatura, `TRIALING` e `CANCELED` seguem direto para o passo 3.
   - **Mensal com `subscriptionId`, `PAST_DUE` e ainda Pro** (dentro do `paidUntil` + 3 dias): não cria checkout. Busca a cobrança vencida mais recente da assinatura atual (ou, sem vencida, a pendente com vencimento até hoje, nunca a do próximo ciclo) e devolve o `invoiceUrl` dela, com `type: 'INVOICE'` e `expiresAt: null`. Pagar essa fatura dispara o `PAYMENT_SUCCEEDED` da mesma assinatura, que volta a `ACTIVE`. Se a pessoa paga com outro cartão, o Asaas troca o cartão da assinatura e as próximas cobranças já saem nele (conferido no sandbox em 2026-11-15). O Asaas gera a cobrança do mês seguinte com antecedência, mesmo com a atual em aberto: por isso a pendente só vale com vencimento até hoje. Sem cobrança em aberto (o pagamento acabou de entrar): `409`. Pedir o anual nesse estado também dá `409`.
   - **Mensal com `subscriptionId` e o Pro já vencido** (`PAST_DUE`, ou `ACTIVE` preso por falta de pagamento): cancela a assinatura antiga no Asaas (o que apaga as cobranças vencidas dela), grava `CANCELED` e segue para o checkout do plano pedido. O `DELETE` do Asaas é idempotente.
   - **Mensal com `subscriptionId`, `ACTIVE` e ainda Pro**: `409 SUBSCRIPTION_ALREADY_ACTIVE`, para qualquer plano. Trocar de ciclo continua bloqueado: cancela e assina o outro depois que o atual vencer.
   - **Anual (cobrança avulsa) ou mensal sem `subscriptionId`**, com o `paidUntil` no futuro: só aceita renovar o próprio anual nos últimos 31 dias (os 30 do aviso do app mais um de folga para o fuso). Fora disso, ou pedindo o mensal, `409`. Com o `paidUntil` no passado (carência ou vencido), aceita qualquer plano.
3. **Reaproveita o checkout recente**: se o item `PENDING_CHECKOUT#<accountId>` é do mesmo plano e do mesmo `returnUrl` e ainda faltam mais de 10 minutos para expirar, devolve o mesmo link. Duas abas ou dois aparelhos abrem o mesmo checkout, que só pode ser pago uma vez. Não cobre dois pedidos no mesmo instante (os dois criam checkout, porque a gravação não é condicional) nem a troca de plano antes de pagar (o checkout do outro plano continua pagável até expirar): nesses casos, quem avisa é o alerta do webhook.
4. Cria o checkout no Asaas com `externalReference = "<accountId>#<planId>"`. É assim que o webhook descobre de quem é o pagamento.
5. Grava um item `GATEWAY#<checkoutId>` com `accountId` e `planId`. É o plano B para identificar a conta quando o evento do Asaas vem sem `externalReference` (pagamentos de assinatura recorrente, por exemplo).
6. Grava o `PENDING_CHECKOUT#<accountId>` com o link, o plano, o `returnUrl` e a expiração (TTL na mesma hora). Os webhooks `CHECKOUT_PAID`, `CHECKOUT_CANCELED` e `CHECKOUT_EXPIRED` apagam o item, para o passo 3 não devolver um link que não serve mais.

A resposta é `{ checkoutUrl, expiresAt, type }`. Com `type: 'INVOICE'`, o app abre a fatura em outra aba no web (a fatura do Asaas não volta para o `returnUrl`) e mostra o painel "Já paguei". No nativo, o fluxo é o mesmo do checkout.

### Passo a passo do webhook

1. **Segurança**: o `@IpAllowlist` recusa IPs fora de `ASAAS_WEBHOOK_ALLOWED_IPS` (`403`). Sem a variável, valem os 4 IPs oficiais de produção do Asaas (`ASAAS_WEBHOOK_PRODUCTION_IPS` em `AppConfig.ts`). `*` desliga a checagem, para sandbox e dev. Depois, `parseWebhook` compara o header `asaas-access-token` com `ASAAS_WEBHOOK_TOKEN`. Token errado lança `BillingError` (`502`).
2. **Tradução**: o evento do Asaas vira um `BillingEvent` neutro. `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` viram `PAYMENT_SUCCEEDED`. `SUBSCRIPTION_CANCELED` e `SUBSCRIPTION_DELETED` viram `SUBSCRIPTION_CANCELED`. `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE` e `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` viram `PAYMENT_REVERSED`, com um `kind` (`REFUNDED`, `PARTIALLY_REFUNDED`, `CHARGEBACK_REQUESTED`, `CHARGEBACK_DISPUTE`, `CHARGEBACK_REVERSAL_PENDING`). Eventos desconhecidos são ignorados (`200 { received: false }`). Os eventos chegam só se estiverem marcados no webhook do painel do Asaas (sandbox e produção têm webhooks separados); o `PAYMENT_REFUND_IN_PROGRESS` fica desmarcado de propósito, porque o efeito vem com o `PAYMENT_REFUNDED`. Cada evento processado deixa uma linha `billing webhook` no log da `webhookAsaas` (`gatewayEvent`, `type`, ids, `accountId` e `result`: `applied`, `not_applied`, `duplicate` ou `unmatched`); evento desconhecido deixa `asaas webhook ignored`. Um erro no meio do processamento sai na linha de erro da request com o `gatewayEvent` e o `eventId` no contexto. A reconciliação não gera essas linhas.
3. **Idempotência**: o `id` do evento é gravado na `RateLimitTable` (`RL#webhook-event#<id>`, TTL de 14 dias). Um evento repetido responde `200` sem fazer nada.
4. **Quem é o dono**: pelo `externalReference`. Se não vier, pelo item `GATEWAY#<checkoutSession>` (ou `GATEWAY#<checkoutId>` nos eventos de checkout) e, por último, pelo `GATEWAY#<subscriptionId>`. Sem dono, responde `200 { received: false }`. A reconciliação acusa esse pagamento depois.
5. **Aplicação**:
   - **Pagamento já coberto**: se o `paidUntil` já cobre o ciclo do pagamento (vencimento + 1 ciclo), nada é gravado (`applied: false`): nem status, nem plano, nem `subscriptionId`. É o caso do `PAYMENT_RECEIVED` do cartão, que chega uns 30 dias depois do `PAYMENT_CONFIRMED` e, sem essa regra, tiraria a conta de `PAST_DUE` ou trocaria a assinatura guardada por uma antiga.
   - **Pagamento já estornado**: um `PAYMENT_SUCCEEDED` de um pagamento que está em `reversedPaymentIds` não grava nada.
   - `PAYMENT_SUCCEEDED`: status `ACTIVE`, `planId` do plano pago (quem fez o trial e pagou o anual passa a `PRO_YEARLY`) e `paidUntil = vencimento + 1 ciclo`. Nunca **reduz** um `paidUntil` existente, então o segundo evento do mesmo pagamento não soma de novo.
   - **Renovação adiantada do anual**: se o anual ainda vale, soma um ano ao `paidUntil` atual em vez de contar do vencimento, para o assinante não perder os dias que faltavam. Limite conhecido: dois pagamentos do anual com menos de um ano entre os vencimentos, ambos antes do `paidUntil`, contam como um só (o app só oferece renovar nos últimos 30 dias).
   - **Pagamento de assinatura já cancelada**: um pagamento da **mesma** assinatura do Asaas que o usuário cancelou (`gatewayRefs.subscriptionId`) não reativa, só estende o `paidUntil`. Isso cobre o `PAYMENT_RECEIVED` do cartão, que chega uns 30 dias depois do `PAYMENT_CONFIRMED`. Pagamento de uma assinatura nova reativa normalmente.
   - `PAYMENT_OVERDUE`: status `PAST_DUE`, exceto se já estiver `CANCELED`. A carência de 3 dias mantém o Pro enquanto o usuário paga a fatura vencida pelo app ("Pagar agora").
   - `SUBSCRIPTION_CANCELED`: status `CANCELED`, com `canceledAt`, exceto se já estiver `CANCELED`.
   - `PAYMENT_OVERDUE` e `SUBSCRIPTION_CANCELED` de uma assinatura do Asaas **diferente** da guardada são ignorados. Sem isso, o `SUBSCRIPTION_DELETED` atrasado da assinatura antiga (cancelada no checkout com o Pro vencido) cancelaria a nova.
   - **Rede de segurança**: publica um alerta no SNS (`AlertGateway`, o mesmo tópico dos alarmes) com a conta, a situação guardada e o pagamento quando chega um `PAYMENT_SUCCEEDED` (a) que não é da assinatura mensal guardada, com ela fora de `CANCELED`, ou (b) de uma assinatura do Asaas com o anual pago no futuro (pagamento coberto, que não grava nada). Pode ser uma segunda assinatura cobrando junto. Nada é cancelado automaticamente: conferir no painel do Asaas ([runbook de alertas](../runbooks/alertas.md#pagamento-de-outra-assinatura-com-o-pro-ativo)). No caso (a), o pagamento é aplicado como antes (a assinatura do pagamento passa a ser a guardada). A reconciliação não dispara o caso (b), para não alertar duas vezes.
   - `PAYMENT_REVERSED`: ver [Estorno e chargeback](#estorno-e-chargeback).
   - `CHECKOUT_PAID`, `CHECKOUT_EXPIRED` e `CHECKOUT_CANCELED` apagam o `PENDING_CHECKOUT#<accountId>`, se ainda for desse checkout. Eles e o `PAYMENT_CREATED` não ativam nada: a ativação vem pelo evento de pagamento.
6. **Escrita condicional**: a assinatura é lida com leitura forte e gravada com `version` (`SubscriptionRepository.save`). Se outra escrita gravou no meio (outro webhook, o cancelamento, o checkout ou a reconciliação), o webhook relê e decide de novo a partir do estado novo, até 3 vezes; depois disso a Lambda falha (`500`), o evento fica sem marcar e o Asaas reenvia. Duas entregas simultâneas criando a mesma assinatura caem no mesmo caminho: o `create` é condicional, e quem perde relê e aplica por cima. Uma chamada ao Asaas feita antes do conflito (cancelar a assinatura no estorno) não é repetida nas novas tentativas da mesma invocação.

### Estorno e chargeback

O `paidUntil` não guarda qual pagamento o gerou. Por isso o estorno desconta **um ciclo** do `paidUntil` atual, e só quando o pagamento devolvido cobre o período atual:

| Evento (`kind`) | Efeito |
|---|---|
| `REFUNDED` (estorno total) ou `CHARGEBACK_REQUESTED` (chargeback aberto) | Desconta o ciclo, se as condições abaixo valerem |
| `PARTIALLY_REFUNDED` | Só alerta (em geral é desconto de cortesia) |
| `CHARGEBACK_DISPUTE` | Só alerta: o Pro já foi descontado quando o chargeback foi aberto |
| `CHARGEBACK_REVERSAL_PENDING` (disputa ganha) | Só alerta: o Pro **não volta sozinho**, devolver à mão se for o caso |

Condições para descontar (senão, só alerta, dizendo por que nada mudou):

1. **Plano atual**: o pagamento é do mesmo plano da assinatura guardada. Na mensal, a assinatura do Asaas do pagamento tem que ser a de `gatewayRefs.subscriptionId`; no anual, o pagamento é avulso (sem assinatura do Asaas). O estorno de uma cobrança duplicada de outra assinatura (o caso do alerta acima) não tira o Pro.
2. **Pagamento aplicado**: o `paymentId` está em `appliedPaymentIds` (os últimos 24 pagamentos que de fato mudaram o `paidUntil`). O estorno de um pagamento que chegou já coberto (pago em dobro, por exemplo dois checkouts do anual no mesmo dia) não desconta o ciclo legítimo. Assinaturas gravadas antes desse campo existir (sem a lista) pulam esta condição até o próximo pagamento.
3. **Período atual**: o fim do ciclo pago (vencimento + 1 ciclo) é mais de 7 dias depois de `paidUntil` - 1 ciclo. A folga cobre o fim do mês (um vencimento em 31/01 dá `paidUntil` 03/03 e o de 28/02 dá 28/03) e não atrapalha a renovação adiantada do anual (no máximo 31 dias antes). O estorno de um mês antigo, já usado, não muda nada.
4. **Sem assinatura substituída**: quando um pagamento de outra assinatura do Asaas entra por cima da mensal guardada ainda ativa (o caso do alerta de cobrança em dobro), a anterior fica em `replacedSubscriptionId`. Enquanto ela estiver lá, o estorno só alerta: o Pro pago pela outra assinatura não é tirado, e a assinatura que sobrou é cancelada à mão no painel. O campo é limpo no próximo pagamento normal da assinatura guardada.
5. **Ainda não descontado**: o `paymentId` não está em `reversedPaymentIds`. O id é gravado na mesma escrita do desconto, então o mesmo estorno de novo (reenvio, `PAYMENT_REFUNDED` depois do chargeback, reconciliação) não desconta duas vezes.

O desconto:

- `paidUntil` volta um ciclo. Na mensal, ele vai para o menor entre `paidUntil` - 1 mês e o vencimento do pagamento devolvido (que já passou), e o Pro acaba. No anual com renovação adiantada, volta para o fim do ano que já estava pago e a conta continua Pro até lá.
- **Mensal fora de `CANCELED`**: cancela a assinatura no Asaas (`DELETE /v3/subscriptions/{id}`, uma chamada de até 10 s, que cabe nos 15 s da Lambda), para não haver cobrança nova de quem pediu o dinheiro de volta. Se o Asaas falhar, nada é gravado, o evento fica sem marcar e o Asaas reenvia. Se o `DELETE` funcionou e a gravação falhou, o reenvio chama o `DELETE` de novo, o que não tem efeito (ele é idempotente no Asaas).
- O estorno de uma assinatura do Asaas que não é a guardada (ou já foi substituída) não a cancela: só alerta.
- Status `CANCELED` (com `canceledAt`) na mensal cancelada no Asaas ou quando o novo `paidUntil` já passou. `CANCELED` não tem a carência de 3 dias, então o Pro acaba na hora. O anual que ainda vale continua `ACTIVE`.
- O app não muda: a conta aparece como expirada em Planos (`CANCELED` com `paidUntil` no passado) e pode assinar de novo.

**Alerta**: todo evento de estorno ou chargeback com dono publica um alerta no SNS. O assunto diz o evento e se o Pro mudou (ex.: "NaCal: estorno total · Pro descontado", "NaCal: estorno parcial · Pro sem mudança"); o corpo diz o que aconteceu, o que fazer, a conta, o pagamento e o estado antes e depois. Falha do alerta não falha o webhook. O que fazer com cada e-mail, com exemplos e os comandos de ajuste manual: [runbook de alertas](../runbooks/alertas.md#estorno-e-chargeback).

O TTL de 14 dias do registro de idempotência acompanha a janela em que o Asaas reenvia eventos. O `reservedConcurrency: 5` da Lambda do webhook é o teto de custo e de concorrência dessa rota pública.

## Trial

`POST /billing/trial` cria uma `Subscription` `TRIALING` de 7 dias, com o plano mensal, **só se a conta nunca teve assinatura**. A criação é condicional, então duas requests simultâneas não criam dois trials. Já teve assinatura: `409 TRIAL_NOT_AVAILABLE`. O trial não passa pelo Asaas nem pede cartão.

## Cancelamento

```mermaid
flowchart TD
    start(["POST /billing/cancel"]) --> find{"Tem assinatura?"}
    find -- "não" --> r400["400 BAD_REQUEST"]
    find -- "já CANCELED" --> same(["200 com status CANCELED<br/>idempotente"])
    find -- "TRIALING" --> trial["CANCELED, sem paidUntil<br/>o Pro acaba na hora"]
    find -- "ACTIVE ou PAST_DUE" --> ref{"Tem subscriptionId<br/>do Asaas?"}
    ref -- "não" --> r502["502 BILLING_ERROR"]
    ref -- "sim" --> asaas["DELETE /v3/subscriptions/{id} no Asaas"]
    asaas --> paid["CANCELED com canceledAt<br/>continua Pro até o paidUntil"]
    trial --> ok(["200 com status"])
    paid --> ok
```

O anual não tem assinatura no Asaas (é cobrança avulsa), então não tem o que cancelar lá: ele só não é renovado. Por isso o app **não mostra** "Cancelar" para o anual ativo. Se a rota for chamada mesmo assim, o anual cai no ramo "sem `subscriptionId`" e recebe `502 BILLING_ERROR`. O aviso de vencimento do anual aparece no app a partir de 30 dias antes do fim.

O cancelamento pelo app é síncrono: cancela no Asaas e grava `CANCELED` na mesma request, sem depender de webhook. A gravação é condicional (`version`): se um webhook gravou enquanto o Asaas respondia, a assinatura é relida e só o `CANCELED` é reaplicado, sem chamar o Asaas de novo. Se nesse meio-tempo a assinatura guardada passou a ser outra (pagamento de outra assinatura do Asaas), nada é gravado e a resposta traz o status atual.

## Erros

| Situação | Resposta |
|---|---|
| `planId` inválido ou `returnUrl` fora do app | `400 VALIDATION` / `400 BAD_REQUEST` |
| Trial já usado ou conta que já teve assinatura | `409 TRIAL_NOT_AVAILABLE` |
| Checkout com mensal `ACTIVE`, troca de ciclo com o Pro pago, anual a mais de 31 dias do vencimento ou `PAST_DUE` sem cobrança em aberto | `409 SUBSCRIPTION_ALREADY_ACTIVE` |
| Mais de 10 checkouts ou cancelamentos por hora na conta | `429 RATE_LIMIT_EXCEEDED` |
| Cancelar sem assinatura | `400 BAD_REQUEST` |
| Cancelar o anual (sem `subscriptionId`) | `502 BILLING_ERROR` |
| O Asaas responde com erro | `502 BILLING_ERROR` |
| Três conflitos seguidos ao gravar a assinatura (escritas simultâneas) | `500` (no webhook, o Asaas reenvia) |
| O Asaas não responde em 10 s ou falha a rede | `502 BILLING_ERROR` (ver abaixo) |
| Webhook de IP fora da allowlist | `403 FORBIDDEN` |
| Webhook com token errado | `502 BILLING_ERROR` |

## Arquivos envolvidos

| Etapa | Arquivo |
|---|---|
| Entidade, planos e plano efetivo | [`Subscription.ts`](../../../src/application/entities/Subscription.ts) |
| Contrato do gateway | [`IPaymentGateway.ts`](../../../src/application/contracts/IPaymentGateway.ts), [`bindings.ts`](../../../src/main/di/bindings.ts) |
| Implementação Asaas | [`AsaasPaymentGateway.ts`](../../../src/infra/gateways/AsaasPaymentGateway.ts) |
| Checkout | [`CreateCheckoutUseCase.ts`](../../../src/application/useCases/billing/CreateCheckoutUseCase.ts) |
| Webhook | [`AsaasWebhookController.ts`](../../../src/application/controllers/billing/AsaasWebhookController.ts), [`WebhookUseCase.ts`](../../../src/application/useCases/billing/WebhookUseCase.ts), [`BillingEventService.ts`](../../../src/application/services/BillingEventService.ts) (regras de cada evento), [`BillingAlertService.ts`](../../../src/application/services/BillingAlertService.ts) (alertas de estorno e de assinatura em dobro) |
| Trial | [`StartTrialUseCase.ts`](../../../src/application/useCases/billing/StartTrialUseCase.ts) |
| Cancelamento | [`CancelUseCase.ts`](../../../src/application/useCases/billing/CancelUseCase.ts) |
| Assinatura, `GATEWAY#` e `PENDING_CHECKOUT#` | [`SubscriptionRepository.ts`](../../../src/infra/databases/dynamodb/SubscriptionRepository.ts) |
| Alerta de assinatura duplicada | [`AlertGateway.ts`](../../../src/infra/gateways/AlertGateway.ts) |
| Tela de Planos (app) | `app/src/ui/screens/plans/usePlansScreen.ts` |
| Idempotência do webhook | [`RateLimitRepository.ts`](../../../src/infra/databases/dynamodb/RateLimitRepository.ts) |

**Timeout do Asaas.** Cada chamada ao Asaas aborta em 10 s (`AbortSignal.timeout`). O `AsaasPaymentGateway.request` converte o `TimeoutError` e a falha de rede do `fetch` em `BillingError` (`502`), e o app mostra a mensagem de serviço de pagamento indisponível. O gateway registra a falha no log antes de converter. As Lambdas que chamam o Asaas têm timeout acima do abort: `checkout` 29 s (pode cancelar a assinatura antiga e criar o checkout na mesma requisição, no máximo duas chamadas seguidas) e `cancel` 15 s. O `webhookAsaas` não chama o Asaas (só confere o token e lê o corpo); os 15 s dele são folga para o DynamoDB e o SNS.
