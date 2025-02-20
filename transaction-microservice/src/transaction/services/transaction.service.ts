import {
  CACHE_MANAGER,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices/client';
import { InjectRepository } from '@nestjs/typeorm';
import { Cache } from 'cache-manager';
import { first } from 'rxjs';
import { Repository } from 'typeorm';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../../database/entities';
import { TransactionStatusEnum } from '../../enums';
import { NotFoundError } from '../../errors';
import { CreateTransactionInput } from '../dto';

@Injectable()
export class TransactionService implements OnModuleInit {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    @Inject('YAPE_SERVICE') private client: ClientKafka,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(TransactionStatus)
    private transactionStatusRepository: Repository<TransactionStatus>,
    @InjectRepository(TransactionType)
    private transactionTypeRepository: Repository<TransactionType>,
  ) {}

  async onModuleInit() {
    this.client.subscribeToResponseOf('yape.new.transaction');
    await this.client.connect();
  }

  async getTransaction(transactionExternalId: string) {
    const value = await this.cacheManager.get<string>(transactionExternalId);

    if (value !== undefined && value !== null) {
      return JSON.parse(value);
    }

    const transaction = await this.transactionRepository.findOne({
      where: { transactionExternalId },
    });

    if (transaction === undefined || transaction === null) {
      this.logger.error(
        'Transaction not found',
        'getTransaction: Transaction not found',
      );
      return new NotFoundError('Transaction not found');
    }

    await this.cacheManager.set(
      transactionExternalId,
      JSON.stringify(transaction),
    );

    return transaction;
  }

  // TODO Paginate
  async getTransactions() {
    return this.transactionRepository.find();
  }

  async getTransactionStatusOfTransactionList(transactionStatusIds: number[]) {
    const noDuplicateTransactionStatusIds = [...new Set(transactionStatusIds)];
    return this.transactionStatusRepository
      .createQueryBuilder('transactionStatus')
      .where('transactionStatus.id IN (:...transactionStatusIds)', {
        transactionStatusIds: noDuplicateTransactionStatusIds,
      })
      .getMany();
  }

  async getTransactionStatusFromBatch(transactionStatusIds: number[]) {
    const transactionStatuses =
      await this.getTransactionStatusOfTransactionList(transactionStatusIds);

    const mappedResults = transactionStatusIds.map((transactionStatusId) => {
      return transactionStatuses.find(
        (transactionStatus) => transactionStatus.id === transactionStatusId,
      );
    });

    return mappedResults;
  }

  async getTransactionTypeOfTransactionList(transactionTypeIds: number[]) {
    const noDuplicateTransactionTypeIds = [...new Set(transactionTypeIds)];
    return this.transactionTypeRepository
      .createQueryBuilder('transactionType')
      .where('transactionType.id IN (:...transactionTypeIds)', {
        transactionTypeIds: noDuplicateTransactionTypeIds,
      })
      .getMany();
  }

  async getTransactionTypeFromBatch(transactionTypeIds: number[]) {
    const transactionTypes = await this.getTransactionTypeOfTransactionList(
      transactionTypeIds,
    );

    const mappedResults = transactionTypeIds.map((transactionTypeId) => {
      return transactionTypes.find(
        (transactionType) => transactionType.id === transactionTypeId,
      );
    });

    return mappedResults;
  }

  async createTransaction(data: CreateTransactionInput) {
    const newTransaction = this.transactionRepository.create({
      value: data.value,
      transactionTypeId: data.tranferTypeId,
      accountExternalIdCredit: data.accountExternalIdCredit,
      accountExternalIdDebit: data.accountExternalIdDebit,
      transactionStatusId: TransactionStatusEnum.PENDING,
    });

    const savedTransaction = await this.transactionRepository.save(
      newTransaction,
    );

    const dataToSend = {
      transactionExternalId: savedTransaction.transactionExternalId,
      transactionValue: savedTransaction.value,
    };

    this.client
      .send('yape.new.transaction', dataToSend)
      .pipe(first()) // ? So it auto unsubscribes and doesn't keep listening (For this challenge I Only need the first response)
      .subscribe({
        next: this.handleAntiFraudResponse,
        error: (err) => {
          this.logger.error(
            err,
            'createTransaction: Error sending message to kafka',
          );
        },
      });

    return savedTransaction;
  }

  async updateTransactionStatus(
    transactionExternalId: string,
    status: TransactionStatusEnum,
  ) {
    this.logger.log(
      `Updating transaction ${transactionExternalId} status to ${status}`,
      'updateTransactionStatus',
    );

    const updateResult = await this.transactionRepository.update(
      { transactionExternalId },
      {
        transactionStatusId: status,
      },
    );

    return updateResult;
  }

  handleAntiFraudResponse = (response: {
    transactionExternalId: string;
    valid: boolean;
  }) => {
    this.updateTransactionStatus(
      response.transactionExternalId,
      response.valid
        ? TransactionStatusEnum.APPROVED
        : TransactionStatusEnum.REJECTED,
    );
  };
}
