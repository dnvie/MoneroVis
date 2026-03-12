export interface DecoyRingMember {
  id: string;
  isTrueSpend?: boolean;
}

export interface DecoyTransactionInput {
  id: string;
  sourceRingMemberId?: string;
  ringMembers: DecoyRingMember[];
}

export interface DecoyTransactionOutput {
  id: string;
}

export interface DecoyTransaction {
  id: string;
  inputs: DecoyTransactionInput[];
  outputs?: DecoyTransactionOutput[];
}

export interface DecoyTransactionResponse {
  mainTransaction: DecoyTransaction;
  childTransactions: DecoyTransaction[];
}

export interface OutputTransactionsMap {
  [outputIndex: string]: string[];
}
