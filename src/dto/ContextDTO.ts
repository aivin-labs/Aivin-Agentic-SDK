import { Message, Session } from "./MessageDTO";
import { User } from "./UserDTO";

export interface MessageContextDTO {
    session?: Session,
    user?: User,
    message: Message,
    userNeed?: string,
}