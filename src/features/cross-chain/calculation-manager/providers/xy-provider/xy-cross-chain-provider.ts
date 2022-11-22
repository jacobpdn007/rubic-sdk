import { BlockchainName, EvmBlockchainName } from 'src/core/blockchain/models/blockchain-name';
import { FeeInfo } from 'src/features/cross-chain/calculation-manager/providers/common/models/fee-info';
import { PriceToken, PriceTokenAmount } from 'src/common/tokens';
import { RequiredCrossChainOptions } from 'src/features/cross-chain/calculation-manager/models/cross-chain-options';
import { Injector } from 'src/core/injector/injector';
import { CROSS_CHAIN_TRADE_TYPE } from 'src/features/cross-chain/calculation-manager/models/cross-chain-trade-type';
import { evmCommonCrossChainAbi } from 'src/features/cross-chain/calculation-manager/providers/common/emv-cross-chain-trade/constants/evm-common-cross-chain-abi';
import { CrossChainProvider } from 'src/features/cross-chain/calculation-manager/providers/common/cross-chain-provider';
import { Web3Pure } from 'src/core/blockchain/web3-pure/web3-pure';
import { nativeTokensList } from 'src/common/tokens/constants/native-tokens';
import BigNumber from 'bignumber.js';
import { blockchainId } from 'src/core/blockchain/utils/blockchains-info/constants/blockchain-id';
import { CalculationResult } from 'src/features/cross-chain/calculation-manager/providers/common/models/calculation-result';
import { getFromWithoutFee } from 'src/features/cross-chain/calculation-manager/utils/get-from-without-fee';
import {
    XyCrossChainSupportedBlockchain,
    xySupportedBlockchains
} from 'src/features/cross-chain/calculation-manager/providers/xy-provider/constants/xy-supported-blockchains';
import { xyContractAddress } from 'src/features/cross-chain/calculation-manager/providers/xy-provider/constants/xy-contract-address';
import { XyCrossChainTrade } from 'src/features/cross-chain/calculation-manager/providers/xy-provider/xy-cross-chain-trade';
import { XyTransactionRequest } from 'src/features/cross-chain/calculation-manager/providers/xy-provider/models/xy-transaction-request';
import { XyTransactionResponse } from 'src/features/cross-chain/calculation-manager/providers/xy-provider/models/xy-transaction-response';
import { XyStatusCode } from 'src/features/cross-chain/calculation-manager/providers/xy-provider/constants/xy-status-code';
import { InsufficientLiquidityError, MinAmountError, RubicSdkError } from 'src/common/errors';

export class XyCrossChainProvider extends CrossChainProvider {
    public static readonly apiEndpoint = 'https://open-api.xy.finance/v1';

    public readonly type = CROSS_CHAIN_TRADE_TYPE.XY;

    public isSupportedBlockchain(
        blockchain: BlockchainName
    ): blockchain is XyCrossChainSupportedBlockchain {
        return xySupportedBlockchains.some(
            supportedBlockchain => supportedBlockchain === blockchain
        );
    }

    public async calculate(
        fromToken: PriceTokenAmount<EvmBlockchainName>,
        toToken: PriceToken<EvmBlockchainName>,
        options: RequiredCrossChainOptions
    ): Promise<CalculationResult> {
        const fromBlockchain = fromToken.blockchain as XyCrossChainSupportedBlockchain;
        const toBlockchain = toToken.blockchain as XyCrossChainSupportedBlockchain;
        if (!this.areSupportedBlockchains(fromBlockchain, toBlockchain)) {
            return null;
        }

        try {
            const receiverAddress =
                options.receiverAddress || this.getWalletAddress(fromBlockchain);

            await this.checkContractState(
                fromBlockchain,
                xyContractAddress[fromBlockchain].rubicRouter,
                evmCommonCrossChainAbi
            );

            const feeInfo = await this.getFeeInfo(fromBlockchain, options.providerAddress);
            const fromWithoutFee = getFromWithoutFee(fromToken, feeInfo);

            const slippageTolerance = options.slippageTolerance * 100;

            const requestParams: XyTransactionRequest = {
                srcChainId: String(blockchainId[fromBlockchain]),
                fromTokenAddress: fromToken.isNative
                    ? XyCrossChainTrade.nativeAddress
                    : fromToken.address,
                amount: fromWithoutFee.stringWeiAmount,
                slippage: String(slippageTolerance),
                destChainId: blockchainId[toBlockchain],
                toTokenAddress: toToken.isNative
                    ? XyCrossChainTrade.nativeAddress
                    : toToken.address,
                receiveAddress: receiverAddress
            };

            const { toTokenAmount, statusCode, msg, xyFee } =
                await Injector.httpClient.get<XyTransactionResponse>(
                    `${XyCrossChainProvider.apiEndpoint}/swap`,
                    {
                        params: { ...requestParams }
                    }
                );
            this.analyzeStatusCode(statusCode, msg);

            const to = new PriceTokenAmount({
                ...toToken.asStruct,
                tokenAmount: Web3Pure.fromWei(toTokenAmount, toToken.decimals)
            });

            const gasData =
                options.gasCalculation === 'enabled'
                    ? await XyCrossChainTrade.getGasData(fromToken, to, requestParams)
                    : null;

            return {
                trade: new XyCrossChainTrade(
                    {
                        from: fromToken,
                        to,
                        transactionRequest: {
                            ...requestParams,
                            receiveAddress: receiverAddress
                        },
                        gasData,
                        priceImpact: fromToken.calculatePriceImpactPercent(to) || 0,
                        slippage: options.slippageTolerance,
                        feeInfo: {
                            ...feeInfo,
                            cryptoFee: {
                                amount: new BigNumber(xyFee!.amount),
                                tokenSymbol: xyFee!.symbol
                            }
                        }
                    },
                    options.providerAddress
                )
            };
        } catch (err) {
            const rubicSdkError = CrossChainProvider.parseError(err);

            return {
                trade: null,
                error: rubicSdkError
            };
        }
    }

    protected async getFeeInfo(
        fromBlockchain: XyCrossChainSupportedBlockchain,
        providerAddress: string
    ): Promise<FeeInfo> {
        return {
            fixedFee: {
                amount: await this.getFixedFee(
                    fromBlockchain,
                    providerAddress,
                    xyContractAddress[fromBlockchain].rubicRouter,
                    evmCommonCrossChainAbi
                ),
                tokenSymbol: nativeTokensList[fromBlockchain].symbol
            },
            platformFee: {
                percent: await this.getFeePercent(
                    fromBlockchain,
                    providerAddress,
                    xyContractAddress[fromBlockchain].rubicRouter,
                    evmCommonCrossChainAbi
                ),
                tokenSymbol: 'USDC'
            },
            cryptoFee: null
        };
    }

    private analyzeStatusCode(code: XyStatusCode, message: string): void {
        switch (code) {
            case '0':
                break;
            case '3':
            case '4':
                throw new InsufficientLiquidityError();
            case '6': {
                const [minAmount, tokenSymbol] = message.split('to ')[1]!.slice(0, -1).split(' ');
                throw new MinAmountError(new BigNumber(minAmount!), tokenSymbol!);
            }
            case '5':
            case '10':
            case '99':
            default:
                throw new RubicSdkError('Unknown Error.');
        }
    }
}