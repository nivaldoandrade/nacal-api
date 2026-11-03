import { AdminCreateUserCommand, AdminLinkProviderForUserCommand, AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand, paginateListUsers, UserType } from '@aws-sdk/client-cognito-identity-provider';
import { cognitoClient } from '@infra/clients/cognitoClient';
import { generateUniqueId } from '@shared/utils/generateUniqueId';
import { PreSignUpTriggerEvent } from 'aws-lambda';

export async function handler(event: PreSignUpTriggerEvent) {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') {
    return event;
  }

  const { userName, userPoolId } = event;
  const { email: rawEmail, name } = event.request.userAttributes;
  const email = rawEmail?.trim().toLowerCase();

  if (!email) {
    throw new Error('Missing email.');
  }

  if (event.triggerSource !== 'PreSignUp_ExternalProvider') {
    return event;
  }

  let nativeUser = await getNativeUserByEmail({ email, userPoolId });

  if (!nativeUser) {
    nativeUser = await createNative({
      name: name || email.split('@')[0],
      email,
      userPoolId,
    });
  } else if (nativeUser.UserStatus !== 'CONFIRMED') {
    await resetUnconfirmedNative({ email, userPoolId });
  }

  const nativeUserId = nativeUser.Attributes?.find(({ Name }) => Name === 'sub')?.Value;

  if (!nativeUserId) {
    throw new Error(`User "${userName}" not found.`);
  }

  const [providerName, providerUserId] = userName.split('_');

  await linkProvider({
    userPoolId,
    nativeUserId,
    providerName,
    providerUserId,
  });

  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
}

interface IGetNativeUserByEmailParams {
  email: string;
  userPoolId: string;
}

async function getNativeUserByEmail({ email, userPoolId }: IGetNativeUserByEmailParams) {
  let nativeUser: UserType | undefined;
  const paginator = paginateListUsers(
    {
      client: cognitoClient,
      pageSize: 1,
    },
    {
      UserPoolId: userPoolId,
      Filter: `email = "${email}"`,
    },
  );

  for await (const page of paginator) {
    const user = page.Users?.find((candidate) => (
      candidate.Attributes?.some(({ Name }) => Name === 'custom:internalId')
    ));

    if (user) {
      nativeUser = user;
      break;
    }
  }

  return nativeUser;
}

interface ICreateNativeParams {
  email: string;
  name: string;
  userPoolId: string;
}

async function createNative({ email, name, userPoolId }: ICreateNativeParams) {
  const internalId = generateUniqueId();

  const command = new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: email,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: name },
      { Name: 'email', Value: email },
      { Name: 'custom:internalId', Value: internalId },
    ],
  });

  const { User } = await cognitoClient.send(command);

  if (!User) {
    throw new Error(`Failed to create native user for email "${email}".`);
  }

  await resetUnconfirmedNative({ email, userPoolId });

  return User;
}

interface IResetUnconfirmedNativeParams {
  email: string;
  userPoolId: string;
}

async function resetUnconfirmedNative({ email, userPoolId }: IResetUnconfirmedNativeParams) {
  const setPasswordCommand = new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: email,
    Password: generateUniqueId(),
    Permanent: true,
  });

  await cognitoClient.send(setPasswordCommand);

  const updateAttributesCommand = new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: email,
    UserAttributes: [
      { Name: 'email_verified', Value: 'true' },
    ],
  });

  await cognitoClient.send(updateAttributesCommand);
}

interface ILinkProviderParams {
  userPoolId: string;
  nativeUserId: string;
  providerName: string;
  providerUserId: string;
}

async function linkProvider({ userPoolId, nativeUserId, providerName, providerUserId }: ILinkProviderParams) {

  const command = new AdminLinkProviderForUserCommand({
    UserPoolId: userPoolId,
    DestinationUser: {
      ProviderName: 'Cognito',
      ProviderAttributeValue: nativeUserId,
    },
    SourceUser: {
      ProviderAttributeName: 'Cognito_Subject',
      ProviderName: providerName,
      ProviderAttributeValue: providerUserId,
    },
  });

  await cognitoClient.send(command);
}
