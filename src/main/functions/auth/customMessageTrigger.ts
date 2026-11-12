import { RenderedEmail } from '@infra/emails/emailLayout';
import { confirmSignUpEmail } from '@infra/emails/templates/confirmSignUpEmail';
import { forgotPasswordEmail } from '@infra/emails/templates/forgotPasswordEmail';
import { CustomMessageTriggerEvent } from 'aws-lambda';

const COGNITO_EMAIL_MAX_LENGTH = 20000;

function getEmail(event: CustomMessageTriggerEvent): RenderedEmail | null {
  const code = event.request.codeParameter;
  const name = event.request.userAttributes.name;

  if (
    event.triggerSource === 'CustomMessage_SignUp'
    || event.triggerSource === 'CustomMessage_ResendCode'
  ) {
    return confirmSignUpEmail({ code, name });
  }

  if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    return forgotPasswordEmail({ code, name });
  }

  return null;
}

export async function handler(event: CustomMessageTriggerEvent) {
  const email = getEmail(event);

  if (!email) {
    return event;
  }

  event.response.emailSubject = email.subject;
  event.response.emailMessage = email.html.length <= COGNITO_EMAIL_MAX_LENGTH
    ? email.html
    : email.text;

  return event;
}
