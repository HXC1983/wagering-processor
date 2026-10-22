export abstract class DomainError extends Error {
  /** Código estável e legível por máquina. */
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
