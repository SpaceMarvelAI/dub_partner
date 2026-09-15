import { isBlacklistedEmail } from "@/lib/edge-config";
import { jackson } from "@/lib/jackson";
import { welcomeUserJob } from "@/lib/jobs/handlers/welcome-user-job";
import { prisma } from "@/lib/prisma";
import { isStored, storage } from "@/lib/storage";
import { UserProps } from "@/lib/types";
import { assertRateLimit } from "@/lib/upstash/assert-rate-limit";
import { RATELIMIT_POLICIES } from "@/lib/upstash/ratelimit-policies";
import { sendEmail } from "@dub/email";
import LoginLink from "@dub/email/templates/login-link";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { PrismaClient } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { User, type NextAuthOptions } from "next-auth";
import { AdapterAccount, AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import GithubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { createId } from "../api/create-id";
import { isProduction } from "../api/environment";
import { isSamlEnforcedForEmailDomain } from "../api/workspaces/is-saml-enforced-for-email-domain";
import { completeProgramApplications } from "../partners/complete-program-applications";
import {
  consumeAdminImpersonation,
  markAdminImpersonation,
} from "./admin-impersonation";
import {
  exceededLoginAttemptsThreshold,
  incrementLoginAttempts,
} from "./lock-account";
import { validatePassword } from "./password";
import { SSO_LOGIN_PROGRAMS } from "./sso-login-programs";
import { trackDubLead } from "./track-dub-lead";

const VERCEL_DEPLOYMENT = !!process.env.VERCEL_URL;
// next-auth/jwt's getToken() (used by middleware to read the session) decides
// the cookie name by checking NEXTAUTH_URL.startsWith("https://") — NOT
// VERCEL_DEPLOYMENT. On a self-hosted HTTPS deployment (e.g. EC2 behind an
// ALB), VERCEL_DEPLOYMENT is false but the site is still https, so the two
// checks disagreed: this config set the plain-named cookie while getToken()
// looked for the __Secure- prefixed one, so middleware could never see an
// authenticated session — login would succeed but bounce straight back to
// /login. Must stay consistent with getToken()'s check.
const IS_SECURE_DEPLOYMENT =
  VERCEL_DEPLOYMENT || !!process.env.NEXTAUTH_URL?.startsWith("https://");

const CustomPrismaAdapter = (p: PrismaClient) => {
  return {
    ...PrismaAdapter(p),
    createUser: async (data: any) => {
      return p.user.create({
        data: {
          ...data,
          id: createId({ prefix: "user_" }),
          notificationPreferences: {
            create: {},
          },
        },
      });
    },
    // Some IdPs (e.g. Beehiiv) return extra token fields
    // so we need to only include the fields that are valid columns on Account table
    linkAccount: (account: AdapterAccount) =>
      p.account.create({
        data: {
          userId: account.userId,
          type: account.type,
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          refresh_token: account.refresh_token,
          refresh_token_expires_in: account.refresh_token_expires_in as any,
          access_token: account.access_token,
          expires_at: account.expires_at,
          token_type: account.token_type,
          scope: account.scope,
          id_token: account.id_token,
          session_state: account.session_state,
        },
      }),
    // simplified version of https://github.com/nextauthjs/next-auth/blob/main/packages/adapter-prisma/src/index.ts#L80
    useVerificationToken: async ({ identifier, token }) => {
      try {
        const verificationToken = await p.verificationToken.delete({
          where: { identifier_token: { identifier, token } },
        });

        if (verificationToken.isAdminImpersonation) {
          markAdminImpersonation(identifier);
        }

        return verificationToken;
      } catch (error: any) {
        if (error.code === "P2025") {
          return null;
        }

        throw error;
      }
    },
  };
};

export const authOptions: NextAuthOptions = {
  providers: [
    EmailProvider({
      async sendVerificationRequest({ identifier, url }) {
        await assertRateLimit({
          policy: RATELIMIT_POLICIES.loginLinkSend,
          identifier,
        });

        if (!isProduction) {
          console.log(`Login link: ${url}`);
          return;
        }

        sendEmail({
          to: identifier,
          subject: "Your Dub Login Link",
          react: LoginLink({ url, email: identifier }),
        });
      },
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      allowDangerousEmailAccountLinking: true,
    }),
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      issuer: "https://github.com/login/oauth",
      allowDangerousEmailAccountLinking: true,
    }),
    {
      id: "saml",
      name: "BoxyHQ",
      type: "oauth",
      version: "2.0",
      checks: ["pkce", "state"],
      authorization: {
        url: `${process.env.NEXTAUTH_URL}/api/auth/saml/authorize`,
        params: {
          scope: "",
          response_type: "code",
          provider: "saml",
        },
      },
      token: {
        url: `${process.env.NEXTAUTH_URL}/api/auth/saml/token`,
        params: { grant_type: "authorization_code" },
      },
      userinfo: `${process.env.NEXTAUTH_URL}/api/auth/saml/userinfo`,
      profile: async (profile) => {
        let existingUser = await prisma.user.findUnique({
          where: { email: profile.email },
        });

        // user is authorized but doesn't have a Dub account, create one for them
        if (!existingUser) {
          existingUser = await prisma.user.create({
            data: {
              id: createId({ prefix: "user_" }),
              email: profile.email,
              name: `${profile.firstName || ""} ${
                profile.lastName || ""
              }`.trim(),
              notificationPreferences: {
                create: {},
              },
            },
          });
        }

        const { id, name, email, image } = existingUser;

        return {
          id,
          name,
          email,
          image,
        };
      },
      options: {
        clientId: "dummy",
        clientSecret: process.env.NEXTAUTH_SECRET as string,
      },
      allowDangerousEmailAccountLinking: true,
    },
    CredentialsProvider({
      id: "saml-idp",
      name: "IdP Login",
      credentials: {
        code: {},
      },
      async authorize(credentials) {
        if (!credentials) {
          return null;
        }

        const { code } = credentials;

        if (!code) {
          return null;
        }

        const { oauthController } = await jackson();

        // Fetch access token
        const { access_token } = await oauthController.token({
          code,
          grant_type: "authorization_code",
          redirect_uri: process.env.NEXTAUTH_URL as string,
          client_id: "dummy",
          client_secret: process.env.NEXTAUTH_SECRET as string,
        });

        if (!access_token) {
          return null;
        }

        // Fetch user info
        const userInfo = await oauthController.userInfo(access_token);

        if (!userInfo) {
          return null;
        }

        let existingUser = await prisma.user.findUnique({
          where: { email: userInfo.email },
        });

        // user is authorized but doesn't have a Dub account, create one for them
        if (!existingUser) {
          existingUser = await prisma.user.create({
            data: {
              id: createId({ prefix: "user_" }),
              email: userInfo.email,
              name: `${userInfo.firstName || ""} ${
                userInfo.lastName || ""
              }`.trim(),
              notificationPreferences: {
                create: {},
              },
            },
          });
        }

        const { id, name, email, image } = existingUser;

        return {
          id,
          email,
          name,
          email_verified: true,
          image,
          // adding profile here so we can access it in signIn callback
          profile: userInfo,
        };
      },
    }),

    // Sign in with email and password
    CredentialsProvider({
      id: "credentials",
      name: "Dub.co",
      type: "credentials",
      credentials: {
        email: { type: "email" },
        password: { type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials) {
          throw new Error("no-credentials");
        }

        const { email, password } = credentials;

        if (!email || !password) {
          throw new Error("no-credentials");
        }

        await assertRateLimit({
          policy: RATELIMIT_POLICIES.login,
          identifier: email.trim().toLowerCase(),
        });

        // SSO enforcement check
        const ssoEnforced = await isSamlEnforcedForEmailDomain(email);

        if (ssoEnforced) {
          throw new Error("require-saml-sso");
        }

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            passwordHash: true,
            name: true,
            email: true,
            image: true,
            invalidLoginAttempts: true,
            emailVerified: true,
          },
        });

        if (!user || !user.passwordHash) {
          throw new Error("invalid-credentials");
        }

        if (exceededLoginAttemptsThreshold(user)) {
          throw new Error("exceeded-login-attempts");
        }

        const passwordMatch = await validatePassword({
          password,
          passwordHash: user.passwordHash,
        });

        if (!passwordMatch) {
          const exceededLoginAttempts = exceededLoginAttemptsThreshold(
            await incrementLoginAttempts(user),
          );

          if (exceededLoginAttempts) {
            throw new Error("exceeded-login-attempts");
          } else {
            throw new Error("invalid-credentials");
          }
        }

        if (!user.emailVerified) {
          throw new Error("email-not-verified");
        }

        // Reset invalid login attempts
        await prisma.user.update({
          where: { id: user.id },
          data: {
            invalidLoginAttempts: 0,
          },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),

    // SSO Login Programs
    ...SSO_LOGIN_PROGRAMS.map(({ slug, name, oauth, mapProfile }) => ({
      id: slug,
      name,
      type: "oauth" as const,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      checks: ["state" as const],
      authorization: {
        url: oauth.authorizationUrl,
        params: {
          scope: oauth.scope,
          response_type: "code",
        },
      },
      token: oauth.tokenUrl,
      userinfo: oauth.userInfoUrl,
      profile(profile) {
        if (mapProfile) return mapProfile(profile);
        const { sub, email, name, picture } = profile;
        return {
          id: sub,
          name,
          email,
          image: picture,
        };
      },
    })),
  ],
  // @ts-ignore
  adapter: CustomPrismaAdapter(prisma),
  session: { strategy: "jwt" },
  cookies: {
    sessionToken: {
      name: `${IS_SECURE_DEPLOYMENT ? "__Secure-" : ""}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        // When working on localhost, the cookie domain must be omitted entirely (https://stackoverflow.com/a/1188145)
        domain: VERCEL_DEPLOYMENT ? ".dub.co" : undefined,
        secure: IS_SECURE_DEPLOYMENT,
      },
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    signIn: async ({ user, account, profile }) => {
      if (!user.email || (await isBlacklistedEmail(user.email))) {
        return false;
      }

      if (user?.lockedAt) {
        throw new Error("exceeded-login-attempts");
      }

      const isAdminImpersonation =
        account?.provider === "email" && consumeAdminImpersonation(user.email);

      // If the user is not using SAML, we need to check if SAML is enforced for the email domain
      if (
        !isAdminImpersonation &&
        account?.provider !== "saml" &&
        account?.provider !== "saml-idp" &&
        account?.provider !== "credentials" // for credentials, we do the check in the CredentialsProvider
      ) {
        const ssoEnforced = await isSamlEnforcedForEmailDomain(user.email);

        if (ssoEnforced) {
          throw new Error("require-saml-sso");
        }
      }

      if (account?.provider === "google" || account?.provider === "github") {
        const userExists = await prisma.user.findUnique({
          where: { email: user.email },
          select: { id: true, name: true, image: true },
        });
        if (!userExists || !profile) {
          return true;
        }
        // if the user already exists via email,
        // update the user with their name and image
        if (userExists && profile) {
          const profilePic =
            profile[account.provider === "google" ? "picture" : "avatar_url"];
          let newAvatar: string | null = null;
          // if the existing user doesn't have an image or the image is not stored in R2
          if (
            (!userExists.image || !isStored(userExists.image)) &&
            profilePic
          ) {
            // Storage (R2/S3) is optional — don't block sign-in over an
            // avatar sync failure when it isn't configured.
            try {
              const { url } = await storage.upload({
                key: `avatars/${userExists.id}`,
                body: profilePic,
              });
              newAvatar = url;
            } catch (error) {
              console.error("Failed to sync avatar from OAuth profile", error);
            }
          }
          await prisma.user.update({
            where: { email: user.email },
            data: {
              // @ts-expect-error - this is a bug in the types, `login` is a valid on the `Profile` type
              ...(!userExists.name && { name: profile.name || profile.login }),
              ...(newAvatar && { image: newAvatar }),
            },
          });
        }
      } else if (
        account?.provider === "saml" ||
        account?.provider === "saml-idp"
      ) {
        let samlProfile;

        if (account?.provider === "saml-idp") {
          // @ts-ignore
          samlProfile = user.profile;
          if (!samlProfile) {
            return true;
          }
        } else {
          samlProfile = profile;
        }

        if (!samlProfile?.requested?.tenant) {
          return false;
        }

        const workspace = await prisma.project.findUnique({
          where: {
            id: samlProfile.requested.tenant,
          },
          select: {
            id: true,
            ssoEmailDomain: true,
          },
        });

        if (workspace) {
          const { ssoEmailDomain } = workspace;
          const emailDomain = user.email.split("@")[1];

          // ssoEmailDomain should be required for all SAML enabled workspace
          // this should not happen
          if (!ssoEmailDomain) {
            return false;
          }

          if (
            emailDomain.toLocaleLowerCase() !==
            ssoEmailDomain.toLocaleLowerCase()
          ) {
            return false;
          }

          await Promise.allSettled([
            // add user to workspace
            prisma.projectUsers.upsert({
              where: {
                userId_projectId: {
                  userId: user.id,
                  projectId: workspace.id,
                },
              },
              update: {},
              create: {
                projectId: workspace.id,
                userId: user.id,
              },
            }),
            // delete any pending invites for this user
            prisma.projectInvite.delete({
              where: {
                email_projectId: {
                  email: user.email,
                  projectId: workspace.id,
                },
              },
            }),
          ]);
        }
      }
      return true;
    },
    jwt: async ({
      token,
      user,
      trigger,
    }: {
      token: JWT;
      user: User | AdapterUser | UserProps;
      trigger?: "signIn" | "update" | "signUp";
    }) => {
      if (user) {
        token.user = user;
      }

      // refresh the user's data if they update their name / email
      if (trigger === "update") {
        const refreshedUser = await prisma.user.findUnique({
          where: {
            id: token.sub,
          },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            isMachine: true,
            defaultWorkspace: true,
            defaultPartnerId: true,
          },
        });

        if (refreshedUser) {
          token.user = refreshedUser;
        } else {
          return {};
        }
      }

      return token;
    },
    session: async ({ session, token }) => {
      session.user = {
        id: token.sub,
        // @ts-ignore
        ...(token || session).user,
      };
      return session;
    },
  },
  events: {
    async signIn(message) {
      const email = message.user.email as string;
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          createdAt: true,
        },
      });
      if (!user) {
        console.log(
          `User ${message.user.email} not found, skipping welcome workflow...`,
        );
        return;
      }
      // only process new user workflow if the user was created in the last 15s (newly created user)
      if (
        user.createdAt &&
        new Date(user.createdAt).getTime() > Date.now() - 15000
      ) {
        console.log(
          `New user ${user.email} created,  triggering welcome workflow...`,
        );
        waitUntil(
          Promise.allSettled([
            // track lead if dub_id cookie is present
            trackDubLead(user),
            // trigger welcome workflow 45 minutes after the user signed up
            welcomeUserJob.dispatch(
              {
                userId: user.id,
              },
              {
                delay: 45 * 60,
                label: user.id,
              },
            ),
          ]),
        );
      }

      // lazily backup user avatar to R2
      const currentImage = message.user.image;
      if (currentImage && !isStored(currentImage)) {
        waitUntil(
          (async () => {
            // Storage (R2/S3) is optional — an uncaught rejection here
            // becomes an unhandled rejection in the request lifecycle
            // (this runs inside the same signIn event as the request),
            // which can destabilize the process. Never let it propagate.
            let url: string;
            try {
              ({ url } = await storage.upload({
                key: `avatars/${message.user.id}`,
                body: currentImage,
              }));
            } catch (error) {
              console.error("Failed to back up user avatar to storage", error);
              return;
            }
            await prisma.user.update({
              where: {
                id: message.user.id,
              },
              data: {
                image: url,
              },
            });
          })(),
        );
      }

      // Complete any outstanding program applications
      if (message.user.email) {
        waitUntil(completeProgramApplications(message.user.email));
      }
    },
  },
};
