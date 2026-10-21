/** Ponto de extensão para JWT validado por IdP externo. Sem autenticação neste timebox. */
export abstract class ProviderIdentityPort {
  abstract assertProvider(providerId: string): void;
}

export class DevelopmentProviderIdentity extends ProviderIdentityPort {
  assertProvider(_providerId: string): void {
    // Apenas desenvolvimento local. A identidade ainda é validada no contrato/domínio.
  }
}
