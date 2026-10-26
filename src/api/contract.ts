import type { Response } from 'express';

export type ApiErrorCode =
    | 'VALIDATION_ERROR'
    | 'QUOTE_FAILED'
    | 'QUOTE_UNVERIFIED'
    | 'DEPOSIT_SUBMISSION_FAILED'
    | 'STATUS_CHECK_FAILED'
    | 'INTERNAL_ERROR';

export interface ApiErrorResponse {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
}

export interface QuoteRequestBody {
    dry?: boolean;
    swapType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
    slippageTolerance?: number;
    /** Deposit transaction metadata mode. Some chains (e.g. Stellar) require MEMO. */
    depositMode?: 'SIMPLE' | 'MEMO';
    originAsset: string;
    destinationAsset: string;
    amount: string;
    refundTo?: string;
    recipient: string;
    deadline?: string;
    referral?: string;
}

export interface DepositRequestBody {
    txHash: string;
    depositAddress: string;
    memo?: string;
    nearSenderAccount?: string;
}

const SWAP_TYPES = new Set([
    'EXACT_INPUT',
    'EXACT_OUTPUT',
    'FLEX_INPUT',
    'ANY_INPUT',
]);

const DEPOSIT_MODES = new Set(['SIMPLE', 'MEMO']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveIntegerString(value: unknown): value is string {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function optionalString(value: unknown): string | undefined {
    return isNonEmptyString(value) ? value : undefined;
}

export function sendError(
    res: Response,
    status: number,
    error: ApiErrorResponse
): void {
    res.status(status).json(error);
}

export function parseQuoteRequestBody(body: unknown): {
    errors: string[];
    value?: QuoteRequestBody;
} {
    const errors: string[] = [];

    if (!isRecord(body)) {
        return {
            errors: ['Request body must be a JSON object.'],
        };
    }

    const {
        dry,
        swapType,
        slippageTolerance,
        depositMode,
        originAsset,
        destinationAsset,
        amount,
        refundTo,
        recipient,
        deadline,
        referral,
    } = body;

    if (!isNonEmptyString(originAsset)) errors.push('originAsset is required.');
    if (!isNonEmptyString(destinationAsset)) {
        errors.push('destinationAsset is required.');
    }
    if (!isPositiveIntegerString(amount)) {
        errors.push('amount must be a positive integer string.');
    }
    if (swapType !== 'EXACT_OUTPUT' && !isNonEmptyString(refundTo)) {
        errors.push('refundTo is required.');
    }
    if (!isNonEmptyString(recipient)) errors.push('recipient is required.');
    if (dry !== undefined && typeof dry !== 'boolean') {
        errors.push('dry must be a boolean.');
    }
    if (
        swapType !== undefined &&
        (!isNonEmptyString(swapType) || !SWAP_TYPES.has(swapType))
    ) {
        errors.push('swapType is invalid.');
    }
    if (
        depositMode !== undefined &&
        (!isNonEmptyString(depositMode) || !DEPOSIT_MODES.has(depositMode))
    ) {
        errors.push('depositMode is invalid.');
    }
    if (
        slippageTolerance !== undefined &&
        (typeof slippageTolerance !== 'number' ||
            !Number.isFinite(slippageTolerance) ||
            slippageTolerance < 0)
    ) {
        errors.push('slippageTolerance must be a non-negative number.');
    }
    if (
        deadline !== undefined &&
        (!isNonEmptyString(deadline) || Number.isNaN(Date.parse(deadline)))
    ) {
        errors.push('deadline must be a valid ISO date string.');
    }

    if (errors.length > 0) {
        return { errors };
    }

    return {
        errors: [],
        value: {
            dry: typeof dry === 'boolean' ? dry : undefined,
            swapType: swapType as QuoteRequestBody['swapType'],
            depositMode: depositMode as QuoteRequestBody['depositMode'],
            slippageTolerance:
                typeof slippageTolerance === 'number'
                    ? slippageTolerance
                    : undefined,
            originAsset: originAsset as string,
            destinationAsset: destinationAsset as string,
            amount: amount as string,
            refundTo: optionalString(refundTo),
            recipient: recipient as string,
            deadline: optionalString(deadline),
            referral: optionalString(referral),
        },
    };
}

export function parseDepositRequestBody(body: unknown): {
    errors: string[];
    value?: DepositRequestBody;
} {
    const errors: string[] = [];

    if (!isRecord(body)) {
        return {
            errors: ['Request body must be a JSON object.'],
        };
    }

    const { txHash, depositAddress, memo, nearSenderAccount } = body;

    if (!isNonEmptyString(txHash)) errors.push('txHash is required.');
    if (!isNonEmptyString(depositAddress)) {
        errors.push('depositAddress is required.');
    }

    if (errors.length > 0) {
        return { errors };
    }

    return {
        errors: [],
        value: {
            txHash: txHash as string,
            depositAddress: depositAddress as string,
            memo: optionalString(memo),
            nearSenderAccount: optionalString(nearSenderAccount),
        },
    };
}
