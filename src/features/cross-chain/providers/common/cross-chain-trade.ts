import { FeeInfo } from 'src/features/cross-chain/providers/common/models/fee';
import { Injector } from 'src/core/injector/injector';
import {
    RubicSdkError,
    WalletNotConnectedError,
    WrongFromAddressError,
    WrongReceiverAddressError
} from 'src/common/errors';
import { CrossChainTradeType } from 'src/features/cross-chain/models/cross-chain-trade-type';
import { PriceTokenAmount } from 'src/common/tokens';
import BigNumber from 'bignumber.js';
import { Web3Private } from 'src/core/blockchain/web3-private-service/web3-private/web3-private';
import { Web3Public } from 'src/core/blockchain/web3-public-service/web3-public/web3-public';
import { HttpClient } from 'src/core/http-client/models/http-client';
import { SwapTransactionOptions } from 'src/features/common/models/swap-transaction-options';
import { EncodeTransactionOptions } from 'src/features/common/models/encode-transaction-options';
import { BasicTransactionOptions } from 'src/core/blockchain/web3-private-service/web3-private/models/basic-transaction-options';
import { ItType } from 'src/features/cross-chain/providers/common/models/it-type';
import { isAddressCorrect } from 'src/features/common/utils/check-address';
import { ERC20_TOKEN_ABI } from 'src/core/blockchain/constants/erc-20-abi';

/**
 * Abstract class for all cross-chain providers' trades.
 */
export abstract class CrossChainTrade {
    /**
     * Type of calculated cross-chain trade.
     */
    public abstract readonly type: CrossChainTradeType;

    /**
     * Token to sell with input amount.
     */
    public abstract readonly from: PriceTokenAmount;

    /**
     * Token to get with output amount.
     */
    public abstract readonly to: PriceTokenAmount;

    /**
     * Minimum amount of output token user will get in Eth units.
     */
    public abstract readonly toTokenAmountMin: BigNumber;

    /**
     * Swap fee information.
     */
    public abstract readonly feeInfo: FeeInfo;

    public abstract readonly itType: ItType;

    protected abstract get fromContractAddress(): string;

    protected get httpClient(): HttpClient {
        return Injector.httpClient;
    }

    protected get fromWeb3Public(): Web3Public {
        return Injector.web3PublicService.getWeb3Public(this.from.blockchain);
    }

    protected get web3Private(): Web3Private {
        return Injector.web3PrivateService.getWeb3PrivateByBlockchain(this.from.blockchain);
    }

    protected get walletAddress(): string {
        return this.web3Private.address;
    }

    protected get methodName(): string {
        return this.from.isNative ? 'routerCallNative' : 'routerCall';
    }

    public get networkFee(): BigNumber {
        return new BigNumber(this.feeInfo.fixedFee?.amount || 0).plus(
            this.feeInfo.cryptoFee?.amount || 0
        );
    }

    protected constructor(protected readonly providerAddress: string) {}

    /**
     * Returns true, if allowance is not enough.
     */
    public async needApprove(): Promise<boolean> {
        this.checkWalletConnected();

        if (this.from.isNative) {
            return false;
        }

        const allowance = await this.fromWeb3Public.getAllowance(
            this.from.address,
            this.walletAddress,
            this.fromContractAddress
        );
        return this.from.weiAmount.gt(allowance);
    }

    /**
     * Sends approve transaction with connected wallet.
     * @param options Transaction options.
     * @param checkNeedApprove If true, first allowance is checked.
     */
    public abstract approve(
        options: BasicTransactionOptions,
        checkNeedApprove?: boolean
    ): Promise<unknown>;

    /**
     * Sends swap transaction with connected wallet.
     * If user has not enough allowance, then approve transaction will be called first.
     *
     * @example
     * ```ts
     * const onConfirm = (hash: string) => console.log(hash);
     * const receipt = await trade.swap({ onConfirm });
     * ```
     *
     * @param options Transaction options.
     */
    public abstract swap(options?: SwapTransactionOptions): Promise<string | never>;

    /**
     * Builds transaction config, with encoded data.
     * @param options Encode transaction options.
     */
    public abstract encode(options: EncodeTransactionOptions): Promise<unknown>;

    public async getApprovePrice(): Promise<GasData> {
        try {
            const web3Public = Injector.web3PublicService.getWeb3Public(this.from.blockchain);
            const [gasLimit, gasPrice] = await Promise.all([
                web3Public.getEstimatedGas(
                    ERC20_TOKEN_ABI,
                    this.from.address,
                    'approve',
                    [this.fromContractAddress, new BigNumber(2).pow(256).minus(1)],
                    this.walletAddress,
                    '0'
                ),
                new BigNumber(await Injector.gasPriceApi.getGasPrice(this.from.blockchain))
            ]);

            if (!gasLimit?.isFinite()) {
                return null;
            }

            const increasedGasLimit = Web3Pure.calculateGasMargin(gasLimit, 1.2);
            return {
                gasLimit: increasedGasLimit,
                gasPrice
            };
        } catch (_err) {
            return null;
        }
    }

    /**
     * Build encoded approve transaction config.
     * @param tokenAddress Address of the smart-contract corresponding to the token.
     * @param spenderAddress Wallet or contract address to approve.
     * @param value Token amount to approve in wei.
     * @param [options] Additional options.
     * @returns Encoded approve transaction config.
     */
    public abstract encodeApprove(
        tokenAddress: string,
        spenderAddress: string,
        value: BigNumber | 'infinity',
        options: BasicTransactionOptions
    ): Promise<unknown>;

    protected async checkTradeErrors(): Promise<void | never> {
        this.checkWalletConnected();
        await Promise.all([this.checkBlockchainCorrect(), this.checkUserBalance()]);
    }

    protected checkWalletConnected(): never | void {
        if (!this.walletAddress) {
            throw new WalletNotConnectedError();
        }
    }

    protected async checkBlockchainCorrect(): Promise<void | never> {
        await this.web3Private.checkBlockchainCorrect(this.from.blockchain);
    }

    protected async checkUserBalance(): Promise<void | never> {
        await this.fromWeb3Public.checkBalance(
            this.from,
            this.from.tokenAmount,
            this.walletAddress
        );
    }

    protected checkFromAddress(fromAddress: string | undefined, isRequired = false): void | never {
        if (!fromAddress) {
            if (isRequired) {
                throw new RubicSdkError(`'fromAddress' is required option`);
            }
            return;
        }
        if (!isAddressCorrect(fromAddress, this.from.blockchain)) {
            throw new WrongFromAddressError();
        }
    }

    protected checkReceiverAddress(
        receiverAddress: string | undefined,
        isRequired = false
    ): void | never {
        if (!receiverAddress) {
            if (isRequired) {
                throw new RubicSdkError(`'receiverAddress' is required option`);
            }
            return;
        }
        if (!isAddressCorrect(receiverAddress, this.to.blockchain)) {
            throw new WrongReceiverAddressError();
        }
    }

    /**
     * @internal
     * Gets ratio between transit usd amount and to token amount.
     */
    public abstract getTradeAmountRatio(fromUsd: BigNumber): BigNumber;

    // private async getPureTokenAmount(): Promise<BigNumber> {
    //     const gasData = await this.getApprovePrice();
    //     const approveGas = new BigNumber(gasData?.gasLimit || 0).multipliedBy(
    //         gasData?.gasPrice || 0
    //     );
    //     const nativeToken = await PriceToken.createToken({
    //         address: EMPTY_ADDRESS,
    //         blockchain: this.from.blockchain
    //     });
    //     const priceTokenAmount = await PriceTokenAmount.createFromToken({
    //         ...nativeToken.asStruct,
    //         tokenAmount: Web3Pure.fromWei(approveGas)
    //     });
    //     const approvePrice = priceTokenAmount.price.multipliedBy(priceTokenAmount.weiAmount);
    //     const finalPrice = this.feeInfo.cryptoFee?.amount;
    // }
}
