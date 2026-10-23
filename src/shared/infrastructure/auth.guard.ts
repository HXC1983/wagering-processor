import { CanActivate, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO: autenticação fora de escopo (ver ARCHITECTURE.md).
 * Aplicado globalmente; para ligar a autenticação, troque este guard por um que valide
 * o token de um Identity Provider (OIDC) e compare o providerId do token com o do payload.
 * Os endpoints de health ficam abertos de qualquer forma.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
