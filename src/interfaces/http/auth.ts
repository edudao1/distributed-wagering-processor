import type { IncomingHttpHeaders } from "node:http";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ForbiddenProviderError } from "../../application/errors";

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");
const IS_PUBLIC = "wagering:isPublic";

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export class ProviderPrincipal {
  private constructor(
    public readonly subject: string,
    private readonly providers: ReadonlySet<string> | "any",
  ) {}

  static anyProvider(subject: string): ProviderPrincipal {
    return new ProviderPrincipal(subject, "any");
  }

  static forProviders(subject: string, providerIds: Iterable<string>): ProviderPrincipal {
    return new ProviderPrincipal(subject, new Set(providerIds));
  }

  canActFor(providerId: string): boolean {
    return this.providers === "any" || this.providers.has(providerId);
  }

  assertCanActFor(providerId: string): void {
    if (!this.canActFor(providerId)) {
      throw new ForbiddenProviderError(providerId);
    }
  }
}

export interface ProviderIdentityPort {
  authenticate(headers: IncomingHttpHeaders): Promise<ProviderPrincipal | undefined>;
}

export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderPrincipal> {
    return ProviderPrincipal.anyProvider("anonymous");
  }
}

const principals = new WeakMap<Request, ProviderPrincipal>();

export function principalOf(request: Request): ProviderPrincipal {
  const principal = principals.get(request);
  if (!principal) {
    throw new UnauthorizedException();
  }
  return principal;
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const principal = await this.identity.authenticate(request.headers);
    if (!principal) {
      throw new UnauthorizedException();
    }
    principals.set(request, principal);
    return true;
  }
}
