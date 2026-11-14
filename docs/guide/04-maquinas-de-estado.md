# 04 · Máquinas de estado

Três entidades têm um ciclo de vida que vale entender antes de mexer no código. Todas as transições são gravadas com **escrita condicional** no DynamoDB: a mudança só acontece se o estado gravado ainda for o esperado. É isso que torna os retries, as mensagens duplicadas e as requests simultâneas seguros.

## Refeição

```mermaid
stateDiagram-v2
    [*] --> UPLOADING: POST /create-meal
    [*] --> SUCCESS: POST /meals/text

    UPLOADING --> QUEUED: arquivo chegou no S3
    UPLOADING --> FAILED: 15 min sem upload

    QUEUED --> PROCESSING: processMeal reivindica
    QUEUED --> FAILED: 15 min sem ninguém pegar<br/>attempts 0
    QUEUED --> FAILED: attempts já é 2

    PROCESSING --> SUCCESS: IA devolveu alimentos
    PROCESSING --> REJECTED: inválido, sem comida
    PROCESSING --> QUEUED: erro na 1ª tentativa
    PROCESSING --> FAILED: erro na 2ª tentativa<br/>ou lease vencido depois de 2

    SUCCESS --> SUCCESS: adicionar, remover ou restaurar itens
    SUCCESS --> DELETED: DELETE /meals/{id}
    REJECTED --> DELETED: DELETE /meals/{id}
    FAILED --> DELETED: DELETE /meals/{id}
```

| De → para | Quem faz | Condição gravada |
|---|---|---|
| `UPLOADING` → `QUEUED` | `newMealUploadedTrigger` | status é `UPLOADING` ou `QUEUED` |
| `QUEUED` → `PROCESSING` | `processMeal` | `QUEUED` (ou `PROCESSING` com lease vencido) e `attempts < 2` |
| `PROCESSING` → `SUCCESS` / `REJECTED` | `processMeal` | status é `PROCESSING` |
| `PROCESSING` → `QUEUED` | `processMeal` | `PROCESSING` com o mesmo `leaseExpiresAt` |
| `*` → `FAILED` | `processMeal` ou `checkMealUpload` (só `UPLOADING`, ou `QUEUED` com `attempts = 0`) | o status, o `attempts` e o lease lidos, numa transação com o estorno |
| `SUCCESS` → `SUCCESS` (adicionar itens) | `addMealItems` | `SUCCESS`, menos de 5 adições, cabe nos 30 itens e dentro das 24 h (sem `foodsVersion`) |
| `SUCCESS` → `SUCCESS` (remover ou restaurar) | `removeMealItem`, `restoreMealItem` | `SUCCESS` e `foodsVersion` igual ao lido |
| `*` → `DELETED` | `deleteMeal` | status é `SUCCESS`, `REJECTED` ou `FAILED` |

Detalhes: [refeição por foto ou áudio](fluxos/refeicao-foto-audio.md#estados-da-refeição) e [itens](fluxos/refeicao-itens.md).

## Assinatura

```mermaid
stateDiagram-v2
    [*] --> TRIALING: POST /billing/trial
    [*] --> ACTIVE: pagamento confirmado
    TRIALING --> ACTIVE: pagamento confirmado
    TRIALING --> CANCELED: POST /billing/cancel
    ACTIVE --> PAST_DUE: pagamento atrasado
    PAST_DUE --> ACTIVE: pagamento confirmado
    ACTIVE --> CANCELED: cancelamento
    PAST_DUE --> CANCELED: cancelamento
    CANCELED --> CANCELED: pagamento da mesma assinatura<br/>só estende o paidUntil
    CANCELED --> ACTIVE: novo checkout pago
```

`PAYMENT_OVERDUE` e o cancelamento pelo webhook valem para qualquer status diferente de `CANCELED`, inclusive `TRIALING`.

O status sozinho não diz se o usuário é Pro: `Subscription.resolveEffectivePlan` cruza o status com `trialEndsAt` e `paidUntil` (com 3 dias de carência). Detalhes em [billing](fluxos/billing.md#estados-da-assinatura).

## Conta e onboarding

```mermaid
stateDiagram-v2
    state "Sem conta" as none
    state "Cognito UNCONFIRMED<br/>+ PendingSignUp" as pending
    state "Account<br/>isOnboarded false" as notOnboarded
    state "Cognito confirmado<br/>sem Account" as orphan
    state "Account<br/>isOnboarded true<br/>+ Profile + Goal" as onboarded

    [*] --> none
    none --> pending: POST /auth/sign-up
    pending --> pending: sign-up repetido<br/>substitui o anterior
    pending --> onboarded: código + senha certa
    pending --> notOnboarded: código + senha diferente
    pending --> onboarded: login com Google<br/>aplica o PendingSignUp
    pending --> none: 24 h sem confirmar<br/>TTL apaga o PendingSignUp
    none --> notOnboarded: primeiro login com Google
    notOnboarded --> onboarded: POST /auth/complete-onboarding
    pending --> orphan: confirmou, mas a gravação<br/>da Account falhou
    orphan --> onboarded: GET /me depois do login<br/>aplica o PendingSignUp válido
    orphan --> notOnboarded: GET /me sem PendingSignUp válido
```

Toda criação de `Account` passa pelo `AccountProvisioningService`, que é idempotente. Detalhes em [cadastro por e-mail](fluxos/auth-cadastro-email.md) e [login com Google](fluxos/auth-google-oauth.md).

Quando o TTL apaga o `PendingSignUp`, o usuário continua no Cognito como `UNCONFIRMED`. Um novo sign-up com o mesmo e-mail substitui esse usuário.
